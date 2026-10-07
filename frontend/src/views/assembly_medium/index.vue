<template>
  <section class="page" data-module="assembly_medium">
    <header class="page-head">
      <div>
        <h2>中组立焊接管理</h2>
        <p class="page-desc">维护中组立分段，围绕组立编号、关联分段、焊接方法、焊材牌号做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记中组立分段</button>
        <button class="btn" type="button" @click="exportRows">导出中组立焊接清单</button>
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
          <td :colspan="columns.length + 2" class="empty-state">暂无中组立焊接数据，可先登记中组立分段</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条中组立焊接记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <section class="jig-panel">
      <h3>胎架占用联动（小组立装配链路）</h3>
      <p class="panel-desc">
        焊接链路与小组立装配共用胎架位：占用中的胎架不可再排产，构件报验归档后胎架位自动释放。
      </p>
      <table class="data-table">
        <thead>
          <tr>
            <th v-for="column in jigColumns" :key="column">{{ column }}</th>
            <th>占用状态</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="jig in jigRows" :key="String(jig.id)">
            <td v-for="column in jigColumns" :key="column">{{ jig[column] || '—' }}</td>
            <td>
              <span class="legend-item" :class="{ 'jig-busy': jig.status === '占用中' }">
                {{ jig.status }}
              </span>
            </td>
          </tr>
          <tr v-if="!jigRows.length">
            <td :colspan="jigColumns.length + 1" class="empty-state">暂无胎架占用记录</td>
          </tr>
        </tbody>
      </table>
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  listJigOccupancy,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { storageKey } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('assembly_medium')
const columns = ["组立编号", "关联分段", "焊接方法", "焊材牌号", "预热温度", "焊工班组", "焊后处理", "组立状态"]
const actions = ["开始组立", "完成焊接", "提交NDT"]
const statuses = ["待组立", "组立中", "焊接中", "已完工", "待NDT"]
const stats = [{"label": "待组立分段", "value": 0}, {"label": "组立中分段", "value": 0}, {"label": "待NDT分段", "value": 0}]
const jigColumns = ["胎架编号", "占用构件", "占用来源", "预约时间", "释放时间"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const jigRows = ref<EntryRow[]>([])
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '中组立分段登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reloadJigs() {
  jigRows.value = listJigOccupancy()
}

// 联动胎架占用：小组立链路在其他标签页预约/释放胎架时，这里跟着刷新。
function onStorage(event: StorageEvent) {
  if (event.key === storageKey()) {
    reloadJigs()
  }
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    reloadJigs()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '中组立焊接列表读取失败'
  }
}

onMounted(() => {
  reload()
  window.addEventListener('storage', onStorage)
})

onUnmounted(() => {
  window.removeEventListener('storage', onStorage)
})
</script>
