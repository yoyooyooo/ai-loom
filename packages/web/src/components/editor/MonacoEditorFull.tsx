import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import * as monaco from 'monaco-editor'
import 'monaco-editor/min/vs/editor/editor.main.css'

export type EditorFullHandle = { getValue: () => string; setValue: (v: string) => void }

type Props = {
  content: string
  language: string
  editable?: boolean
  onSave?: (value: string) => void
}

const MonacoEditorFull = forwardRef<EditorFullHandle, Props>(function MonacoEditorFull({ content, language, editable, onSave }, ref) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const modelRef = useRef<monaco.editor.ITextModel | null>(null)

  const savingRef = useRef(false)

  useEffect(() => {
    if (!containerRef.current) return
    if (!editorRef.current) {
      modelRef.current = monaco.editor.createModel(content, language)
      editorRef.current = monaco.editor.create(containerRef.current, {
        model: modelRef.current,
        readOnly: !editable,
        theme: 'vs',
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        lineNumbers: 'on',
        wordWrap: 'off',
      })
      // 捕获 Ctrl/⌘+S，并阻止浏览器默认行为
      editorRef.current.onKeyDown((e) => {
        if ((e.ctrlKey || e.metaKey) && e.keyCode === monaco.KeyCode.KeyS) {
          try { (e as any).stopPropagation?.() } catch {}
          e.preventDefault()
          if (savingRef.current) return
          savingRef.current = true
          const val = modelRef.current?.getValue() ?? ''
          onSave?.(val)
          // 简单节流，避免重复触发（onKeyDown + 可能的浏览器层快捷）
          setTimeout(()=>{ savingRef.current = false }, 300)
        }
      })
    }
    return () => {}
  }, [])

  useEffect(() => {
    const m = modelRef.current
    if (!m) return
    m.setValue(content)
    monaco.editor.setModelLanguage(m, language || 'plaintext')
  }, [content, language])

  useImperativeHandle(ref, () => ({
    getValue: () => modelRef.current?.getValue() ?? '',
    setValue: (v: string) => { modelRef.current?.setValue(v) }
  }))

  return (
    <div className="w-full h-full border rounded overflow-hidden">
      <div ref={containerRef} className="w-full h-full" />
    </div>
  )
})

export default MonacoEditorFull
