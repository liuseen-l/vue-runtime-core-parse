import { hyphenate, isArray } from '@vue/shared'
import {
  ComponentInternalInstance,
  callWithAsyncErrorHandling
} from '@vue/runtime-core'
import { ErrorCodes } from 'packages/runtime-core/src/errorHandling'

interface Invoker extends EventListener {
  value: EventValue
  attached: number
}

type EventValue = Function | Function[]

export function addEventListener(
  el: Element,
  event: string,
  handler: EventListener,
  options?: EventListenerOptions
) {
  el.addEventListener(event, handler, options)
}

export function removeEventListener(
  el: Element,
  event: string,
  handler: EventListener,
  options?: EventListenerOptions
) {
  el.removeEventListener(event, handler, options)
}
/**
 * 
 * 当更新事件时，由于 el._vei 已经存在了，所以我们只需要将invoker.value 的值修改为新的事件处理函数即可。这样，在更新
   事件时可以避免一次 removeEventListener 函数的调用，从而提升了性能。实际上，伪造的事件处理函数的作用不止于此，
   它还能解决事件冒泡与事件更新之间相互影响的问题。
 */
export function patchEvent(
  el: Element & { _vei?: Record<string, Invoker | undefined> },
  rawName: string, // 比如onClick
  prevValue: EventValue | null,
  nextValue: EventValue | null,
  instance: ComponentInternalInstance | null = null
) {
  // vei = vue event invokers 
  /**
   *  在绑定事件时，我们可以绑定一个伪造的事件处理函数 invoker，然后把真正的事件处理函数设置为 invoker.value属性的值。这样当更新事件的时候，我们将不再需要调用
     removeEventListener 函数来移除上一次绑定的事件，只需要更新invoker.value 的值即可，如下面的代码所示：
   */
  const invokers = el._vei || (el._vei = {})
  const existingInvoker = invokers[rawName] // /根据事件名称获取 invoker

     // 存在新事件并且之前有绑定过相关类型的事件，比如点击事件 onClick，那么就是一个更新操作
  if (nextValue && existingInvoker) {
    // patch
    existingInvoker.value = nextValue
  } else {
    // 执行到这就两种情况，1：第一次挂载添加事件，nextValue存在，existingInvoker不存在 2：卸载事件，nextValue 为空，existingInvoker 存在
    const [name, options] = parseName(rawName) // 转换rawName，比如 onClick -> click
    // 添加事件
    if (nextValue) { // nextValue存在，existingInvoker不存在
      // 添加invoker
      const invoker = (invokers[rawName] = createInvoker(nextValue, instance))
      addEventListener(el, name, invoker, options)
    } else if (existingInvoker) { // nextValue 为空，existingInvoker 存在
      // remove
      removeEventListener(el, name, existingInvoker, options)
      invokers[rawName] = undefined
    }
  }
}

const optionsModifierRE = /(?:Once|Passive|Capture)$/

function parseName(name: string): [string, EventListenerOptions | undefined] {
  let options: EventListenerOptions | undefined
  if (optionsModifierRE.test(name)) {
    options = {}
    let m
    while ((m = name.match(optionsModifierRE))) {
      name = name.slice(0, name.length - m[0].length)
      ;(options as any)[m[0].toLowerCase()] = true
    }
  }
  const event = name[2] === ':' ? name.slice(3) : hyphenate(name.slice(2))
  return [event, options]
}

// To avoid the overhead of repeatedly calling Date.now(), we cache
// and use the same timestamp for all event listeners attached in the same tick.
let cachedNow: number = 0
const p = /*#__PURE__*/ Promise.resolve()
const getNow = () =>
  cachedNow || (p.then(() => (cachedNow = 0)), (cachedNow = Date.now()))


/**
 * 首先需要了解一下 invoker 的结构，invoker本身是一个函数 (e) => {...}，最后是需要交给 addEventListener 去绑定的，当监听事件触发时，就会执行invoker
 * 并且会将点击事件对象event 传给 invoker，invoker内部再去访问自身的 value 属性，value属性存储的就是用户传入的真正事件，比如 onClick={fn}，那么value存储的就是
 * fn，比如 value = fn,但是有可能用户绑定了多个 onClick事件，那么此时value存储的就是一个事件的数组比如 value = [fn,fn2,fn3],因此invoker内部通过invoker.value(e)去
 * 真正调用事件时需要判断一下value是一个函数还是一个数组
 *  */
function createInvoker(
  initialValue: EventValue,
  instance: ComponentInternalInstance | null
) {
  const invoker: Invoker = (e: Event & { _vts?: number }) => {
    // async edge case vuejs/vue#6566
    // inner click event triggers patch, event handler
    // attached to outer element during patch, and triggered again. This
    // happens because browsers fire microtask ticks between event propagation.
    // this no longer happens for templates in Vue 3, but could still be
    // theoretically possible for hand-written render functions.
    // the solution: we save the timestamp when a handler is attached,
    // and also attach the timestamp to any event that was handled by vue
    // for the first time (to avoid inconsistent event timestamp implementations
    // or events fired from iframes, e.g. #2513)
    // The handler would only fire if the event passed to it was fired
    // AFTER it was attached.
    if (!e._vts) {
      e._vts = Date.now() // 存储事件发生的时间
    } else if (e._vts <= invoker.attached) {
      // 如果事件发生的时间早于事件处理函数绑定的时间，则不执行事件处理函数
      return
    }
    callWithAsyncErrorHandling(
      patchStopImmediatePropagation(e, invoker.value),
      instance,
      ErrorCodes.NATIVE_EVENT_HANDLER,
      [e]
    )
  }
  invoker.value = initialValue // 添加 nextValue(函数或者数组)
  invoker.attached = getNow() // 添加 invoker.attached 属性，存储事件处理函数被绑定的时间
  return invoker
}

// 加工一下，有些事件用户需要去阻止冒泡或者捕获
function patchStopImmediatePropagation(
  e: Event,
  value: EventValue
): EventValue {
  if (isArray(value)) {
    const originalStop = e.stopImmediatePropagation
    e.stopImmediatePropagation = () => {
      originalStop.call(e);
      (e as any)._stopped = true
    }
    return value.map(fn => (e: Event) => !(e as any)._stopped && fn && fn(e))
  } else {
    return value
  }
}
