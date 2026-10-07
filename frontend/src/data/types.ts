/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
  /** 登记时必填的字段 */
  requiredFields?: string[]
  /** 严格顺序流转链：只能逐级顺推，不允许跳级或倒走 */
  flowChain?: string[]
  /** 归档状态：进入后记录保持不变，任何动作都拒绝 */
  archiveStatus?: string
  /** 占用胎架的字段名；带该字段的模块共用同一个胎架占用池 */
  jigField?: string
  /** 进入这些状态后释放胎架 */
  jigReleaseStatuses?: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type CreateResult = ActionResult & {
  row?: EntryRow
}

export type JigOccupant = {
  jig: string
  moduleKey: string
  moduleName: string
  rowId: number
  code: string
  status: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
