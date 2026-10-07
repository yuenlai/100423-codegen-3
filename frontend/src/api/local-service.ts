import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, reloadFromStorage, resetRows, saveRows } from '@/data/local-store'
import type {
  ActionResult,
  AssemblySmallCreateInput,
  EntryRow,
  ModuleMeta,
  OverviewResult,
  PageResult,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 严格顺序流转的模块：链上状态只能一级一级顺着往下推，不允许跳级或倒走；终态归档后冻结。
const STRICT_FLOWS: Record<string, string[]> = {
  assembly_small: ['待装配', '装配中', '自检合格', '已报验'],
}

// 胎架占用台账：小组立装配按胎架位排产，焊接链路（中组立）联动读这份占用记录。
const JIG_LEDGER_KEY = 'jig_occupancy'
const JIG_LOCK_NAME = 'ship-block-construction:jig-booking'

function timestamp(): string {
  return new Date().toLocaleString('zh-CN', { hour12: false })
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

// 预约胎架先拿锁再落库：并发（含多标签页）同时抢一个胎架位时，只有先锁定的能写进去。
async function withJigLock<T>(task: () => T): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
  if (!locks) {
    return task()
  }
  return locks.request(JIG_LOCK_NAME, { mode: 'exclusive' }, () => task())
}

// 构件报验归档后胎架位空出来排下一个构件；归档的构件记录本身不再改动。
function releaseJig(entry: EntryRow): void {
  const component = String(entry['构件编号'] ?? '')
  const rows = listRows(JIG_LEDGER_KEY)
  let changed = false
  const next = rows.map((row) => {
    if (row.status === '占用中' && String(row['占用构件']) === component) {
      changed = true
      return { ...row, status: '已释放', pending: false, 释放时间: timestamp() }
    }
    return row
  })
  if (changed) {
    saveRows(JIG_LEDGER_KEY, next)
  }
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  const flow = STRICT_FLOWS[key]
  if (flow && current === flow[flow.length - 1]) {
    return { ok: false, message: `${meta.entity}已报验归档，记录保持不变，不能再流转` }
  }
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  if (flow) {
    const currentIndex = flow.indexOf(current)
    const targetIndex = flow.indexOf(target)
    if (currentIndex < 0 || targetIndex !== currentIndex + 1) {
      return {
        ok: false,
        message: `${meta.entity}只能按「${flow.join('→')}」逐级往下推，不允许跳级或倒走（当前「${current}」）`,
      }
    }
  }
  const terminal = flow ? flow[flow.length - 1] : meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== terminal,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  if (key === 'assembly_small' && target === '已报验') {
    releaseJig(updated)
  }
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

// 登记小组立构件并按胎架位排产：同一胎架位只认第一次预约，并发时先锁定的落库。
export async function createAssemblySmallEntry(
  input: AssemblySmallCreateInput,
): Promise<ActionResult> {
  return withJigLock(() => {
    // 锁内重读持久化数据，保证看到其他标签页刚刚落库的占用记录。
    reloadFromStorage()
    const meta = moduleMeta('assembly_small')
    const required: (keyof AssemblySmallCreateInput)[] = [
      '构件编号',
      '关联分段',
      '装配胎架',
      '装配班组',
    ]
    for (const field of required) {
      if (!input[field].trim()) {
        return { ok: false, message: `登记${meta.entity}必须先填「${field}」` }
      }
    }
    const rows = listRows('assembly_small')
    const code = input.构件编号.trim()
    if (rows.some((row) => String(row['构件编号']) === code)) {
      return { ok: false, message: `构件编号「${code}」已经登记过，不能重复落库` }
    }
    const jig = input.装配胎架.trim()
    const ledger = listRows(JIG_LEDGER_KEY)
    const holder = ledger.find((row) => row.status === '占用中' && String(row['胎架编号']) === jig)
    if (holder) {
      return {
        ok: false,
        message: `胎架「${jig}」正被构件「${holder['占用构件']}」占用，只认第一次预约`,
      }
    }
    const entry: EntryRow = {
      id: nextId(rows),
      status: '待装配',
      pending: true,
      abnormal: false,
      构件编号: code,
      关联分段: input.关联分段.trim(),
      构件类型: input.构件类型.trim(),
      装配胎架: jig,
      装配班组: input.装配班组.trim(),
      装配日期: input.装配日期.trim(),
      报验结果: input.报验结果.trim() || '未报验',
      装配状态: '待装配',
    }
    const booking: EntryRow = {
      id: nextId(ledger),
      status: '占用中',
      pending: true,
      abnormal: false,
      胎架编号: jig,
      占用构件: code,
      占用来源: '小组立装配',
      预约时间: timestamp(),
      释放时间: '',
    }
    saveRows(JIG_LEDGER_KEY, [...ledger, booking])
    saveRows('assembly_small', [...rows, entry])
    return {
      ok: true,
      message: `${meta.entity}「${code}」已登记，胎架「${jig}」预约成功，当前状态「待装配」`,
    }
  })
}

// 胎架占用台账：给焊接链路（中组立焊接）联动展示。
export function listJigOccupancy(): EntryRow[] {
  return listRows(JIG_LEDGER_KEY)
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
