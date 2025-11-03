import { BehaviorSubject, Subject } from 'rxjs'

export type GenEntry = { generating: boolean; updatedAt: number; lastEventId: number }
export type GenState = { byKey: Record<string, GenEntry>; version: number }
export type GenSeedPayload = { key: string; generating: boolean; lastEventId?: number }

export const generatingState$$ = new BehaviorSubject<GenState>({ byKey: {}, version: 0 })
export const generatingSeed$$ = new Subject<GenSeedPayload>()

export function resetGeneratingSubjects() {
  generatingState$$.next({ byKey: {}, version: 0 })
}
