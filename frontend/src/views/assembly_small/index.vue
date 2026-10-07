<template>
  <section class="page" data-module="assembly_small">
    <header class="page-head">
      <div>
        <h2>小组立装配管理</h2>
        <p class="page-desc">维护小组立构件，围绕构件编号、关联分段、构件类型、装配胎架做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记小组立构件</button>
        <button class="btn" type="button" @click="exportRows">导出小组立装配清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <p class="jig-legend">
      <span class="jig-title">胎架占用（与中组立焊接联动）：</span>
      <span v-if="!jigs.length" class="legend-item">当前无占用</span>
      <span v-for="item in jigs" :key="`${item.moduleKey}-${item.rowId}`" class="legend-item">
        {{ item.jig }} · {{ item.moduleName }} {{ item.code }}（{{ item.status }}）
      </span>
    </p>

    <form v-if="showCreate" class="filter-bar create-panel" @submit.prevent="submitCreate">
      <label v-for="field in createFields" :key="field" class="filter-item">
        <span>
          {{ field }}
          <i v-if="isRequired(field)" class="required-mark">*</i>
        </span>
        <input
          v-model="draft[field]"
          :type="field === '装配日期' ? 'date' : 'text'"
          :placeholder="`填写${field}`"
        />
      </label>
      <button class="btn primary" type="submit">提交登记</button>
      <button class="btn ghost" type="button" @click="closeCreate">取消</button>
    </form>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无小组立装配数据，可先登记小组立构件</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条小组立装配记录</span>
      <span v-if="noticeMessage" class="ok-text">{{ noticeMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  createEntry,
  downloadEntries,
  jigOccupancy,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow, JigOccupant } from '@/data/types'

const meta = moduleMeta('assembly_small')
const columns = ["构件编号", "关联分段", "构件类型", "装配胎架", "装配班组", "装配日期", "报验结果", "装配状态"]
const actions = ["开始装配", "提交自检", "申请报验"]
const statuses = ["待装配", "装配中", "自检合格", "已报验", "需返修"]
const stats = [{"label": "待装配构件", "value": 0}, {"label": "装配中构件", "value": 0}, {"label": "报验通过数", "value": 0}]
// 登记表单去掉状态展示列，状态由流转链自己维护
const createFields = columns.filter((column) => !column.endsWith('状态'))

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const noticeMessage = ref('')
const filters = ref<Record<string, string>>({})
const showCreate = ref(false)
const draft = ref<Record<string, string>>({})
const jigs = ref<JigOccupant[]>([])
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function isRequired(field: string) {
  return (meta.requiredFields ?? []).includes(field)
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  draft.value = { 装配日期: new Date().toISOString().slice(0, 10) }
  showCreate.value = true
  errorMessage.value = ''
  noticeMessage.value = ''
}

function closeCreate() {
  showCreate.value = false
  draft.value = {}
}

function submitCreate() {
  errorMessage.value = ''
  noticeMessage.value = ''
  const result = createEntry(meta.key, draft.value)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  noticeMessage.value = result.message
  closeCreate()
  reload()
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  noticeMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  noticeMessage.value = result.message
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    jigs.value = jigOccupancy()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '小组立装配列表读取失败'
  }
}

onMounted(reload)
</script>
