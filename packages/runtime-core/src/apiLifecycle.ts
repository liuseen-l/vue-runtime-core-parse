import {
  ComponentInternalInstance,
  currentInstance,
  isInSSRComponentSetup,
  LifecycleHooks,
  setCurrentInstance,
  unsetCurrentInstance
} from './component'
import { ComponentPublicInstance } from './componentPublicInstance'
import { callWithAsyncErrorHandling, ErrorTypeStrings } from './errorHandling'
import { warn } from './warning'
import { toHandlerKey } from '@vue/shared'
import { DebuggerEvent, pauseTracking, resetTracking } from '@vue/reactivity'

export { onActivated, onDeactivated } from './components/KeepAlive'

export function injectHook(
  type: LifecycleHooks, // 声明周期钩子类型
  hook: Function & { __weh?: Function }, // 用户传给声明周期钩子的回调
  target: ComponentInternalInstance | null = currentInstance, // 默认拿到当前执行的组件的实例，也可以shou'dong
  prepend: boolean = false
): Function | undefined {
  // 判断获取的当前执行的组件实例是否存在
  if (target) {
    const hooks = target[type] || (target[type] = [])
    // cache the error handling wrapper for injected hooks so the same hook
    // can be properly deduped by the scheduler. "__weh" stands for "with error
    // handling".
    const wrappedHook =
      hook.__weh ||
      (hook.__weh = (...args: unknown[]) => {
        if (target.isUnmounted) {
          return
        }
        // disable tracking inside all lifecycle hooks
        // since they can potentially be called inside effects.
        pauseTracking()
        // Set currentInstance during hook invocation.
        // This assumes the hook does not synchronously trigger other hooks, which
        // can only be false when the user does something really funky.
        // 想想这里为什么还要设置setCurrentInstance(target)，这一步执行是在什么时候
        /**
         * 我们在执行setup函数之前，会调用setCurrentInstance，将当前挂载的组件的实例设置为currentInstance，然后
         * 在执行setup函数当中如果调用了getCurrentInstance方法的话，就可以获取到组件的实例，同时，如果在setup函数中调用了
         * 生命周期钩子函数，那么会向组件实例身上注册这些回调函数，但是有个注意的点就是传入的回调不是原封不动的就注册到实例身上
         * 而是包裹了一层，和闭包类似
         * 
         *setCurrentInstance()
         *function setup(){
         * function onMounted(hook,instance = currentInstance)}{
         *    const wrappedHook = ()=>{
         *        setCurrentInstance(instance)
         *        hook() // 用户传入的声明周期回调函数
         *        unsetCurrentInstance()
         *    }
         *    instance.mounted.push(wrappedHook)
         * } 
         *} 
         *unsetCurrentInstance()
         *
         * 在挂载阶段，执行setup函数之前我们设置了currentInstance,因此执行setup函数的时候，可以获取到currentInstance，因此当我们执行到
         * onMounted函数的时候，是可以访问到currentInstance的，这里将第二个实例参数默认就设置为currentInstance，当然也可以用户手动传递，比如传递
         * 父组件的instance，然后内部再将用户传入的hook包裹一下注册到instance身上，那么组件更新触发生命周期钩子回调时，执行的实际上是wrappedHook，
         * 然后通过闭包原理，可以访问到组件挂载时的instance，调用setCurrentInstance(instance)设置currentInstance，那么在执行真正用户传入的hook中
         * 就可以通过getCurrentInstance()方法获取组件的实例
         * 
         * 
         * 因此证明了只有组件挂载时和执行声明周期钩子时，能够通过getCurrentInstace()获取到组件的实例
         */
        setCurrentInstance(target)
        // 真正执行钩子回调函数的地方
        const res = callWithAsyncErrorHandling(hook, target, type, args)
        unsetCurrentInstance()
        resetTracking()
        return res
      })
    if (prepend) {
      hooks.unshift(wrappedHook)
    } else {
      // 假设当前用户调用了 onBeforeUpdate钩子函数，那么 hooks = instance['bu'] ，是一个数组，用来存放回调,刚开始为[]
      hooks.push(wrappedHook)
    }
    return wrappedHook
  } else if (__DEV__) {
    // 当前实例不存在，则说明用户没有在 setup 函数内调用 onMounted 函
    // 数，这是错误的用法，因此我们应该抛出错误及其原因。

    const apiName = toHandlerKey(ErrorTypeStrings[type].replace(/ hook$/, ''))
    warn(
      `${apiName} is called when there is no active component instance to be ` +
        `associated with. ` +
        `Lifecycle injection APIs can only be used during execution of setup().` +
        (__FEATURE_SUSPENSE__
          ? ` If you are using async setup(), make sure to register lifecycle ` +
            `hooks before the first await statement.`
          : ``)
    )
  }
}

// 返回一个函数 
export const createHook =
  <T extends Function = () => any>(lifecycle: LifecycleHooks) =>
  // hook就是用户传入的生命钩子回调
  (hook: T, target: ComponentInternalInstance | null = currentInstance) =>
    // post-create lifecycle registrations are noops during SSR (except for serverPrefetch)
    (!isInSSRComponentSetup || lifecycle === LifecycleHooks.SERVER_PREFETCH) &&
    injectHook(lifecycle, (...args: unknown[]) => hook(...args), target)

export const onBeforeMount = createHook(LifecycleHooks.BEFORE_MOUNT)
export const onMounted = createHook(LifecycleHooks.MOUNTED)
export const onBeforeUpdate = createHook(LifecycleHooks.BEFORE_UPDATE)
export const onUpdated = createHook(LifecycleHooks.UPDATED)
export const onBeforeUnmount = createHook(LifecycleHooks.BEFORE_UNMOUNT)
export const onUnmounted = createHook(LifecycleHooks.UNMOUNTED)
export const onServerPrefetch = createHook(LifecycleHooks.SERVER_PREFETCH)

export type DebuggerHook = (e: DebuggerEvent) => void
export const onRenderTriggered = createHook<DebuggerHook>(
  LifecycleHooks.RENDER_TRIGGERED
)
export const onRenderTracked = createHook<DebuggerHook>(
  LifecycleHooks.RENDER_TRACKED
)

export type ErrorCapturedHook<TError = unknown> = (
  err: TError,
  instance: ComponentPublicInstance | null,
  info: string
) => boolean | void

export function onErrorCaptured<TError = Error>(
  hook: ErrorCapturedHook<TError>,
  target: ComponentInternalInstance | null = currentInstance
) {
  injectHook(LifecycleHooks.ERROR_CAPTURED, hook, target)
}
