import { http } from '@/lib/request'

export type RuntimeSettingsResponse = {
  codexHome: string
}

export async function fetchRuntimeSettings() {
  const res = await http.get<RuntimeSettingsResponse>('/api/settings/runtime')
  return res.data
}

export async function updateRuntimeSettings(payload: RuntimeSettingsResponse) {
  const res = await http.put<RuntimeSettingsResponse>('/api/settings/runtime', payload)
  return res.data
}
