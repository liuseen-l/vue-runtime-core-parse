import { ErrorCodes, callWithErrorHandling } from './errorHandling'
import { isArray, NOOP } from '@vue/shared'
import { ComponentInternalInstance, getComponentName } from './component'
import { warn } from './warning'

export interface SchedulerJob extends Function {
  id?: number
  pre?: boolean
  active?: boolean
  computed?: boolean
  /**
   * Indicates whether the effect is allowed to recursively trigger itself
   * when managed by the scheduler.
   *
   * By default, a job cannot trigger itself because some built-in method calls,
   * e.g. Array.prototype.push actually performs reads as well (#1740) which
   * can lead to confusing infinite loops.
   * The allowed cases are component update functions and watch callbacks.
   * Component update functions may update child component props, which in turn
   * trigger flush: "pre" watch callbacks that mutates state that the parent
   * relies on (#1801). Watch callbacks doesn't track its dependencies so if it
   * triggers itself again, it's likely intentional and it is the user's
   * responsibility to perform recursive state mutation that eventually
   * stabilizes (#1727).
   */
  allowRecurse?: boolean
  /**
   * Attached by renderer.ts when setting up a component's render effect
   * Used to obtain component information when reporting max recursive updates.
   * dev only.
   */
  ownerInstance?: ComponentInternalInstance
}

export type SchedulerJobs = SchedulerJob | SchedulerJob[]

let isFlushing = false
let isFlushPending = false

const queue: SchedulerJob[] = []
let flushIndex = 0

const pendingPostFlushCbs: SchedulerJob[] = []
let activePostFlushCbs: SchedulerJob[] | null = null
let postFlushIndex = 0

const resolvedPromise = /*#__PURE__*/ Promise.resolve() as Promise<any>
let currentFlushPromise: Promise<void> | null = null

const RECURSION_LIMIT = 100
type CountMap = Map<SchedulerJob, number>

// 因为nextTick函数的执行地方是在setup函数当中的，和watch的执行地方是相同的
export function nextTick<T = void>(
  this: T,
  fn?: (this: T) => void
): Promise<void> {
  /**
     <script setup>
        import { ref,watch,nextTick } from 'vue'
        let r = ref(1)
        watch(r,()=>{
            console.log('change')
        })
        function add(){
          r.value++        // r.value++ 和 nextTick 交换顺序执行时机会不一样
          nextTick(()=>{
            console.log('new nextTick')
          })
        }
        </script>

        <template>
            <div>
              {{r}}
          </div>
          <button @click="add">
          </button>
        </template>

    #  resolvedPromise = Promise.resolve()
    先改值，是 resolvedPromise.then(watch).then(nextTick)
    
    先nextTick是 resolvedPromise.then(nextTick)
                resolvedPromise.then(watch)
   * 
   *  */
  const p = currentFlushPromise || resolvedPromise
  // 直接返回 p 是支持 await nextTick(),相当于 await Promise.resolve()
  return fn ? p.then(this ? fn.bind(this) : fn) : p
}

// #2768
// Use binary-search to find a suitable position in the queue,
// so that the queue maintains the increasing order of job's id,
// which can prevent the job from being skipped and also can avoid repeated patching.
// 这里需要id呈递增序列（意味着按顺序更新），然后运用了一个二分查找，来找到传入id的job应该插入到哪个位置
function findInsertionIndex(id: number) {
  // the start index should be `flushIndex + 1`
  let start = flushIndex + 1
  let end = queue.length

  while (start < end) {
    const middle = (start + end) >>> 1
    const middleJobId = getId(queue[middle])
    middleJobId < id ? (start = middle + 1) : (end = middle)
  }

  return start
}

// 组件响应式数据发生变化时，调度器的主要函数，用来将一个任务添加到缓存队列中，并开始刷新队列
export function queueJob(job: SchedulerJob) {
  // 如果当前缓存队列中没有任务，且当前传入的任务不在缓存队列中执行
  if (
    !queue.length ||
    !queue.includes(
      job,
      isFlushing && job.allowRecurse ? flushIndex + 1 : flushIndex
    )
  ) {
    if (job.id == null) {
      queue.push(job)
    } else {
      // 组件更新触发的该函数和watch flush = pre | post 都走这里，插入之前，需要调整顺序，确保缓存队列中id的顺序是递增的，在调整的过程会发现，组件的更新job会排在在watch的job的前面
      // watch.id = update.id = instance.id
      // 按照job.id自增的顺序排列 0 1 2 3 4
      queue.splice(findInsertionIndex(job.id), 0, job)
    }
    queueFlush()
  }
}

function queueFlush() {
  // 如果还没有开始刷新队列，则刷新之
  if (!isFlushing && !isFlushPending) {
  // 将该标志设置为 true 以避免重复刷新
    isFlushPending = true
    // 这里充分说明了组件更新的effect，以及wacth flush = pre 和 post的回调函数都是在所有响应式数据更新完毕之后再进行的，这些数据更新是同步的，而缓存队列由于是微任务，所以
    // 组件更新的effect 以及 watch flush = pre 和 post 的回调都是最后同步任务执行完毕再执行的异步任务
    currentFlushPromise = resolvedPromise.then(flushJobs) // 相当于 Promise.resolve().then(function)
  }
}

export function invalidateJob(job: SchedulerJob) {
  const i = queue.indexOf(job)
  if (i > flushIndex) {
    queue.splice(i, 1)
  }
}

export function queuePostFlushCb(cb: SchedulerJobs) {
  if (!isArray(cb)) {
    if (
      !activePostFlushCbs ||
      !activePostFlushCbs.includes(
        cb,
        cb.allowRecurse ? postFlushIndex + 1 : postFlushIndex
      )
    ) {
      pendingPostFlushCbs.push(cb)
    }
  } else {
    // if cb is an array, it is a component lifecycle hook which can only be
    // triggered by a job, which is already deduped in the main queue, so
    // we can skip duplicate check here to improve perf
    pendingPostFlushCbs.push(...cb)
  }
  queueFlush()
}

export function flushPreFlushCbs(
  seen?: CountMap,
  // if currently flushing, skip the current job itself
  i = isFlushing ? flushIndex + 1 : 0
) {
  if (__DEV__) {
    seen = seen || new Map()
  }
  for (; i < queue.length; i++) {
    const cb = queue[i]
    if (cb && cb.pre) {
      if (__DEV__ && checkRecursiveUpdates(seen!, cb)) {
        continue
      }
      queue.splice(i, 1)
      i--
      cb()
    }
  }
}

export function flushPostFlushCbs(seen?: CountMap) {
  if (pendingPostFlushCbs.length) {
    const deduped = [...new Set(pendingPostFlushCbs)]
    pendingPostFlushCbs.length = 0

    // #1947 already has active queue, nested flushPostFlushCbs call
    if (activePostFlushCbs) {
      activePostFlushCbs.push(...deduped)
      return
    }

    activePostFlushCbs = deduped
    if (__DEV__) {
      seen = seen || new Map()
    }

    activePostFlushCbs.sort((a, b) => getId(a) - getId(b))

    for (
      postFlushIndex = 0;
      postFlushIndex < activePostFlushCbs.length;
      postFlushIndex++
    ) {
      if (
        __DEV__ &&
        checkRecursiveUpdates(seen!, activePostFlushCbs[postFlushIndex])
      ) {
        continue
      }
      activePostFlushCbs[postFlushIndex]()
    }
    activePostFlushCbs = null
    postFlushIndex = 0
  }
}

const getId = (job: SchedulerJob): number =>
  job.id == null ? Infinity : job.id

const comparator = (a: SchedulerJob, b: SchedulerJob): number => {
  const diff = getId(a) - getId(b)
  if (diff === 0) {
    if (a.pre && !b.pre) return -1
    if (b.pre && !a.pre) return 1
  }
  return diff
}

function flushJobs(seen?: CountMap) {
  isFlushPending = false
  isFlushing = true
  if (__DEV__) {
    seen = seen || new Map()
  }

  // Sort queue before flush.
  // This ensures that:
  // 1. Components are updated from parent to child. (because parent is always
  //    created before the child so its render effect will have smaller
  //    priority number)
  // 2. If a component is unmounted during a parent component's update,
  //    its update can be skipped.
  queue.sort(comparator)

  // conditional usage of checkRecursiveUpdate must be determined out of
  // try ... catch block since Rollup by default de-optimizes treeshaking
  // inside try-catch. This can leave all warning code unshaked. Although
  // they would get eventually shaken by a minifier like terser, some minifiers
  // would fail to do that (e.g. https://github.com/evanw/esbuild/issues/1610)
  const check = __DEV__
    ? (job: SchedulerJob) => checkRecursiveUpdates(seen!, job)
    : NOOP

  try {
    for (flushIndex = 0; flushIndex < queue.length; flushIndex++) {
      const job = queue[flushIndex]
      if (job && job.active !== false) {
        if (__DEV__ && check(job)) {
          continue
        }
        // console.log(`running:`, job.id)
        callWithErrorHandling(job, null, ErrorCodes.SCHEDULER)
      }
    }
  } finally {
    flushIndex = 0
    queue.length = 0

    flushPostFlushCbs(seen)

    isFlushing = false
    currentFlushPromise = null
    // some postFlushCb queued jobs!
    // keep flushing until it drains.
    if (queue.length || pendingPostFlushCbs.length) {
      flushJobs(seen)
    }
  }
}

function checkRecursiveUpdates(seen: CountMap, fn: SchedulerJob) {
  if (!seen.has(fn)) {
    seen.set(fn, 1)
  } else {
    const count = seen.get(fn)!
    if (count > RECURSION_LIMIT) {
      const instance = fn.ownerInstance
      const componentName = instance && getComponentName(instance.type)
      warn(
        `Maximum recursive updates exceeded${
          componentName ? ` in component <${componentName}>` : ``
        }. ` +
          `This means you have a reactive effect that is mutating its own ` +
          `dependencies and thus recursively triggering itself. Possible sources ` +
          `include component template, render function, updated hook or ` +
          `watcher source function.`
      )
      return true
    } else {
      seen.set(fn, count + 1)
    }
  }
}
