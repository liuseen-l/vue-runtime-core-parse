import {
  Component,
  ConcreteComponent,
  currentInstance,
  ComponentInternalInstance,
  isInSSRComponentSetup,
  ComponentOptions
} from './component'
import { isFunction, isObject } from '@vue/shared'
import { ComponentPublicInstance } from './componentPublicInstance'
import { createVNode, VNode } from './vnode'
import { defineComponent } from './apiDefineComponent'
import { warn } from './warning'
import { ref } from '@vue/reactivity'
import { handleError, ErrorCodes } from './errorHandling'
import { isKeepAlive } from './components/KeepAlive'
import { queueJob } from './scheduler'

export type AsyncComponentResolveResult<T = Component> = T | { default: T } // es modules

export type AsyncComponentLoader<T = any> = () => Promise<
  AsyncComponentResolveResult<T>
>

export interface AsyncComponentOptions<T = any> {
  loader: AsyncComponentLoader<T>
  loadingComponent?: Component
  errorComponent?: Component
  delay?: number
  timeout?: number
  suspensible?: boolean
  onError?: (
    error: Error,
    retry: () => void,
    fail: () => void,
    attempts: number
  ) => any
}

export const isAsyncWrapper = (i: ComponentInternalInstance | VNode): boolean =>
  !!(i.type as ComponentOptions).__asyncLoader

// defineAsyncComponent 函数用于定义一个异步组件，接收一个异步组件加载器作为参数
// 例如 source = ()=>import('xx.vue')
export function defineAsyncComponent<
  T extends Component = { new(): ComponentPublicInstance }
>(source: AsyncComponentLoader<T> | AsyncComponentOptions<T>): T {
  // options 可以是配置项，也可以是加载器
  if (isFunction(source)) {
    // 如果 options 是加载器，则将其格式化为配置项形式
    source = { loader: source }
  }

  const {
    loader, // 加载器
    loadingComponent, // 加载组件
    errorComponent, // 指定出错时要渲染的组件
    delay = 200,
    timeout, // 超时时长，其单位为 ms undefined = never times out
    suspensible = true,
    onError: userOnError
  } = source


  let pendingRequest: Promise<ConcreteComponent> | null = null
  let resolvedComp: ConcreteComponent | undefined

  // 记录重试次数
  let retries = 0
  // 重试函数
  const retry = () => {
    retries++
    pendingRequest = null
    return load()
  }

  const load = (): Promise<ConcreteComponent> => {
    let thisRequest: Promise<ConcreteComponent>
    return (
      pendingRequest ||
      (thisRequest = pendingRequest =
        // loader = () => import('xxx.vue'),import会返回一个promise，并作为loader函数调用的返回值
        loader()
          // 添加 catch 语句来捕获加载过程中的错误
          // 加载器加载过程中如果报错，在这里进行捕获
          .catch(err => {
            err = err instanceof Error ? err : new Error(String(err))
            if (userOnError) {
              // 当错误发生时，返回一个新的 Promise 实例，并调用 onError 回调(也就是useOnError)，
              // 同时将 retry 函数作为 onError 回调的参数
              return new Promise((resolve, reject) => {
                const userRetry = () => resolve(retry())
                const userFail = () => reject(err)
                userOnError(err, userRetry, userFail, retries + 1)
              })
            } else {
              throw err
            }
          })
          // comp 为 import('xxx.vue')加载的组件，
          .then((comp: any) => {
            if (thisRequest !== pendingRequest && pendingRequest) {
              return pendingRequest
            }
            if (__DEV__ && !comp) {
              warn(
                `Async component loader resolved to undefined. ` +
                `If you are using retry(), make sure to return its return value.`
              )
            }
            // interop module default
            if (
              comp &&
              (comp.__esModule || comp[Symbol.toStringTag] === 'Module')
            ) {
              comp = comp.default
            }
            if (__DEV__ && comp && !isObject(comp) && !isFunction(comp)) {
              throw new Error(`Invalid async component load result: ${comp}`)
            }
            resolvedComp = comp
            return comp
          }))
    )
  }

  // 返回一个组件，这里通过defineCompoent生成组件，实际上在script标签中引入其他的组件vue文件也会这样去包裹
  return defineComponent({
    name: 'AsyncComponentWrapper',

    __asyncLoader: load,

    get __asyncResolved() {
      return resolvedComp
    },

    setup() {
      const instance = currentInstance!

      // already resolved
      if (resolvedComp) {
        return () => createInnerComp(resolvedComp!, instance)
      }

      const onError = (err: Error) => {
        pendingRequest = null
        handleError(
          err,
          instance,
          ErrorCodes.ASYNC_COMPONENT_LOADER,
          !errorComponent /* do not throw in dev if user provided error component */
        )
      }

      // suspense-controlled or SSR.
      if (
        (__FEATURE_SUSPENSE__ && suspensible && instance.suspense) ||
        (__SSR__ && isInSSRComponentSetup)
      ) {
        return load()
          .then(comp => {
            return () => createInnerComp(comp, instance)
          })
          .catch(err => {
            onError(err)
            return () =>
              errorComponent
                ? createVNode(errorComponent as ConcreteComponent, {
                  error: err
                })
                : null
          })
      }

      // 异步组件是否加载成功
      const loaded = ref(false)
      // 定义 error，当错误发生时，用来存储错误对象
      const error = ref()
      // 一个标志，代表是否正在加载,默认为 true
      // 如果配置项中存在 delay，则开启一个定时器计时，当延迟到时后将 loading.value 设置为 false
      // 如果配置项中没有 delay，则直接标记为加载中
      const delayed = ref(!!delay)

      if (delay) {
        setTimeout(() => {
          delayed.value = false
        }, delay)
      }

      // 超时报错
      if (timeout != null) {
        setTimeout(() => {
          // 超时后创建一个错误对象，并复制给 error.value
          if (!loaded.value && !error.value) {
            const err = new Error(
              `Async component timed out after ${timeout}ms.`
            )
            onError(err)
            error.value = err
          }
        }, timeout)
      }

      load()
        .then(() => {
          loaded.value = true
          if (instance.parent && isKeepAlive(instance.parent.vnode)) {
            // parent is keep-alive, force update so the loaded component's
            // name is taken into account
            queueJob(instance.parent.update)
          }
        })
        .catch(err => {
          onError(err)
          error.value = err
        })

      // 在这里，我们看到setup返回的是一个函数，因此render会被赋值为这个函数，render函数在异步组件的effect中执行的时候，
      // 会访问loaded.value，这个过程实际上会和这个内置的异步组件的effect建立依赖关系，刚开始的时候由于异步组件的内容没有请求
      // 完毕，会返回{ type: Text, children: 'loading' }，这是一个内部的组件，因此异步组件会渲染这个内部组件，但是当我们
      // 请求的子组件的内容加载完毕之后，会设置InnerComp的值为子组件的内容，然后再设置loaded.value 为 true，loading的setter过
      // 程会触发异步组件的effect重新执行，执行过程中会重新调用render函数，但是由于此时的loader.value已经为true了，因此会返
      // 回 { type:InnderComp }，这个InndrComp存储的就是子组件返回的vnode，这就是整个异步组件渲染的全部过程。


      // 大致的流程图就是
      // App.vue -> 内置的异步组件（建立响应式），返回loading组件的vnode -> 渲染loading组件（子组件没有加载完毕的时候）-> 
      // 子组件加载完毕（触发内置的异步组件的effect重新执行）-> 内置异步返回子组件的vnode -> 渲染子组件

      return () => {
        // 如果组件异步加载成功，则渲染被加载的组件
        if (loaded.value && resolvedComp) {
          return createInnerComp(resolvedComp, instance)
        } else if (error.value && errorComponent) {
          // 只有当错误存在且用户配置了 errorComponent 时才展示 Error 组件，同时将 error 作为 props 传递
          return createVNode(errorComponent as ConcreteComponent, {
            error: error.value
          })
        } else if (loadingComponent && !delayed.value) {
          // 如果异步组件正在加载，并且用户指定了 Loading 组件，则渲染 Loading 组件
          return createVNode(loadingComponent as ConcreteComponent)
        }
      }
    }
  }) as T
}

function createInnerComp(
  comp: ConcreteComponent,
  parent: ComponentInternalInstance
) {
  const { ref, props, children, ce } = parent.vnode
  const vnode = createVNode(comp, props, children)
  // ensure inner component inherits the async wrapper's ref owner
  vnode.ref = ref
  // pass the custom element callback on to the inner comp
  // and remove it from the async wrapper
  vnode.ce = ce
  delete parent.vnode.ce

  return vnode
}
