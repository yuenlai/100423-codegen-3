import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, refreshRows, resetRows, saveRows } from '@/data/local-store'
import type {
  ActionResult,
  CreateResult,
  EntryRow,
  JigOccupant,
  ModuleMeta,
  OverviewResult,
  PageResult,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

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
  // 先对齐最新落库数据，再判断、再写，避免拿着旧缓存覆盖别的页面的改动。
  refreshRows()
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (meta.archiveStatus && current === meta.archiveStatus) {
    return { ok: false, message: `${meta.entity}已「${meta.archiveStatus}」归档，保持不变，不能再${action}` }
  }
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  if (meta.flowChain) {
    const chain = meta.flowChain
    const currentIndex = chain.indexOf(current)
    const targetIndex = chain.indexOf(target)
    if (targetIndex < 0) {
      return { ok: false, message: `「${action}」不在${meta.name}的流转链上` }
    }
    if (currentIndex < 0) {
      return { ok: false, message: `当前状态「${current}」不在流转链上，不能${action}` }
    }
    if (targetIndex !== currentIndex + 1) {
      return {
        ok: false,
        message: `只能按 ${chain.join('→')} 逐级顺推，不允许跳级或倒走`,
      }
    }
  }
  const chainEnd = meta.flowChain
    ? meta.flowChain[meta.flowChain.length - 1]
    : meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== chainEnd,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

// 胎架占用池：所有带 jigField 的模块共用一个池，没到释放状态的记录都算占用。
export function jigOccupancy(): JigOccupant[] {
  const rows = allRows()
  const occupants: JigOccupant[] = []
  for (const meta of MODULE_BY_KEY.values()) {
    if (!meta.jigField) {
      continue
    }
    const released = meta.jigReleaseStatuses ?? []
    for (const row of rows[meta.key] ?? []) {
      const jig = String(row[meta.jigField] ?? '').trim()
      if (!jig || released.includes(String(row.status))) {
        continue
      }
      occupants.push({
        jig,
        moduleKey: meta.key,
        moduleName: meta.name,
        rowId: Number(row.id),
        code: String(row[meta.fields[0]] ?? row.id),
        status: String(row.status),
      })
    }
  }
  return occupants
}

export function createEntry(key: string, values: Record<string, string>): CreateResult {
  const meta = moduleMeta(key)
  for (const field of meta.requiredFields ?? []) {
    if (!String(values[field] ?? '').trim()) {
      return { ok: false, message: `${field}不能为空，登记${meta.entity}前要先填好` }
    }
  }
  // 预约先锁先得：绕过缓存直读落库数据，检查通过后同步写库，并发时只有先锁定的能落库。
  refreshRows()
  const rows = listRows(key)
  const primaryField = meta.fields[0]
  const code = String(values[primaryField] ?? '').trim()
  if (code && rows.some((row) => String(row[primaryField]) === code)) {
    return { ok: false, message: `${primaryField} ${code} 已登记，不能重复` }
  }
  let jig = ''
  if (meta.jigField) {
    jig = String(values[meta.jigField] ?? '').trim()
    if (jig) {
      const holder = jigOccupancy().find((item) => item.jig === jig)
      if (holder) {
        return {
          ok: false,
          message: `胎架 ${jig} 已被${holder.moduleName} ${holder.code} 预约（${holder.status}），只认第一次预约`,
        }
      }
    }
  }
  const id = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  const status = meta.statuses[0]
  const row: EntryRow = { id, status, pending: true, abnormal: false }
  for (const field of meta.fields) {
    const value = String(values[field] ?? '').trim()
    // 状态类展示字段登记时与初始状态对齐，后续以「当前状态」列为准。
    row[field] = value || (field.endsWith('状态') ? status : '')
  }
  saveRows(key, [...rows, row])
  const jigNote = jig ? `，胎架 ${jig} 已锁定` : ''
  return { ok: true, message: `${meta.entity} ${code || id} 已登记为「${status}」${jigNote}`, row }
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
