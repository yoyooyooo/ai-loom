export type ResumeBanner =
  | { kind: 'info'; message: string }
  | { kind: 'error'; message: string }
  | null
