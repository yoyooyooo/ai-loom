'use client'

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowUp, Info, Loader2, Mic, Paperclip, Square } from 'lucide-react'

import { cn } from '@/lib/utils'
import { useAudioRecording } from '@/hooks/use-audio-recording'
import { useAutosizeTextArea } from '@/hooks/use-autosize-textarea'
import { AudioVisualizer } from '@/components/ui/audio-visualizer'
import { Button } from '@/components/ui/button'
import { FilePreview } from '@/components/ui/file-preview'
import { InterruptPrompt } from '@/components/ui/interrupt-prompt'

interface MessageInputBaseProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  value: string
  submitOnEnter?: boolean
  stop?: () => void
  isGenerating: boolean
  enableInterrupt?: boolean
  transcribeAudio?: (blob: Blob) => Promise<string>
  leftExtras?: React.ReactNode
}

interface MessageInputWithoutAttachmentProps extends MessageInputBaseProps {
  allowAttachments?: false
}

interface MessageInputWithAttachmentsProps extends MessageInputBaseProps {
  allowAttachments: true
  files: File[] | null
  setFiles: React.Dispatch<React.SetStateAction<File[] | null>>
}

type MessageInputProps = MessageInputWithoutAttachmentProps | MessageInputWithAttachmentsProps

export function MessageInput({
  placeholder = 'Ask AI...',
  className,
  onKeyDown: onKeyDownProp,
  submitOnEnter = true,
  stop,
  isGenerating,
  enableInterrupt = true,
  transcribeAudio,
  leftExtras,
  ...props
}: MessageInputProps) {
  const [isDragging, setIsDragging] = useState(false)
  const [showInterruptPrompt, setShowInterruptPrompt] = useState(false)

  const {
    isListening,
    isSpeechSupported,
    isRecording,
    isTranscribing,
    audioStream,
    toggleListening,
    stopRecording
  } = useAudioRecording({
    transcribeAudio,
    onTranscriptionComplete: (text) => {
      props.onChange?.({ target: { value: text } } as any)
    }
  })

  useEffect(() => {
    if (!isGenerating) setShowInterruptPrompt(false)
  }, [isGenerating])

  const addFiles = (files: File[] | null) => {
    if ((props as any).allowAttachments) {
      ;(props as any).setFiles((currentFiles: File[] | null) => {
        if (currentFiles === null) return files
        if (files === null) return currentFiles
        return [...currentFiles, ...files]
      })
    }
  }

  const onDragOver = (event: React.DragEvent) => {
    if ((props as any).allowAttachments !== true) return
    event.preventDefault()
    setIsDragging(true)
  }
  const onDragLeave = (event: React.DragEvent) => {
    if ((props as any).allowAttachments !== true) return
    event.preventDefault()
    setIsDragging(false)
  }
  const onDrop = (event: React.DragEvent) => {
    setIsDragging(false)
    if ((props as any).allowAttachments !== true) return
    event.preventDefault()
    const dataTransfer = event.dataTransfer
    if (dataTransfer.files.length) addFiles(Array.from(dataTransfer.files))
  }

  const onPaste = (event: React.ClipboardEvent) => {
    const items = event.clipboardData?.items
    if (!items) return
    const text = event.clipboardData.getData('text')
    if (text && text.length > 500 && (props as any).allowAttachments) {
      event.preventDefault()
      const blob = new Blob([text], { type: 'text/plain' })
      const file = new File([blob], 'Pasted text', { type: 'text/plain', lastModified: Date.now() })
      addFiles([file])
      return
    }
    const files = Array.from(items)
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null)
    if ((props as any).allowAttachments && files.length > 0) addFiles(files)
  }

  const [isComposing, setIsComposing] = useState(false)

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const composing = (event.nativeEvent as any)?.isComposing || isComposing
    const isEnter = event.key === 'Enter'
    if (submitOnEnter && isEnter && !event.shiftKey && !composing) {
      event.preventDefault()
      if (isGenerating && stop && enableInterrupt) {
        if (showInterruptPrompt) {
          stop()
          setShowInterruptPrompt(false)
          event.currentTarget.form?.requestSubmit()
        } else if (
          (props as any).value ||
          ((props as any).allowAttachments && (props as any).files?.length)
        ) {
          setShowInterruptPrompt(true)
          return
        }
      }
      event.currentTarget.form?.requestSubmit()
    }
    onKeyDownProp?.(event)
  }

  const textAreaRef = useRef<HTMLTextAreaElement>(null)
  const [textAreaHeight, setTextAreaHeight] = useState<number>(0)
  useEffect(() => {
    if (textAreaRef.current) setTextAreaHeight(textAreaRef.current.offsetHeight)
  }, [(props as any).value])

  const showFileList =
    (props as any).allowAttachments && (props as any).files && (props as any).files.length > 0

  useAutosizeTextArea({
    ref: textAreaRef,
    maxHeight: 240,
    borderWidth: 0,
    dependencies: [(props as any).value, showFileList]
  })

  const textareaProps = useMemo(() => {
    if ((props as any).allowAttachments) {
      const { allowAttachments, files, setFiles, ...rest } = props as any
      return rest
    }
    const { allowAttachments, ...rest } = props as any
    return rest
  }, [props])

  return (
    <div
      className="relative w-full rounded-xl border border-input bg-background p-3"
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {enableInterrupt && (
        <InterruptPrompt isOpen={showInterruptPrompt} close={() => setShowInterruptPrompt(false)} />
      )}
      <RecordingPrompt isVisible={isRecording} onStopRecording={stopRecording} />

      <div className="relative">
        <textarea
          aria-label="Write your prompt here"
          placeholder={placeholder}
          ref={textAreaRef}
          onCompositionStart={() => setIsComposing(true)}
          onCompositionEnd={() => setIsComposing(false)}
          onPaste={onPaste}
          onKeyDown={onKeyDown}
          className={cn(
            'z-10 w-full grow resize-none bg-transparent text-sm placeholder:text-muted-foreground focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 p-0 pr-24',
            'pb-4',
            className
          )}
          {...(textareaProps as any)}
        />

        {(props as any).allowAttachments && (
          <div className="absolute inset-x-0 bottom-10 z-20 overflow-x-auto py-2">
            <div className="flex space-x-3">
              <AnimatePresence mode="popLayout">
                {(props as any).files?.map((file: File) => (
                  <FilePreview
                    key={file.name + String(file.lastModified)}
                    file={file}
                    onRemove={() => {
                      ;(props as any).setFiles((files: File[] | null) => {
                        if (!files) return null
                        const filtered = Array.from(files).filter((f) => f !== file)
                        if (filtered.length === 0) return null
                        return filtered
                      })
                    }}
                  />
                ))}
              </AnimatePresence>
            </div>
          </div>
        )}
      </div>

      <div className="absolute right-3 top-3 z-20 flex gap-2">
        {isGenerating && stop ? (
          <Button
            type="button"
            size="icon"
            className="h-8 w-8"
            aria-label="Stop generating"
            onClick={stop}
          >
            <Square className="h-3 w-3 animate-pulse" fill="currentColor" />
          </Button>
        ) : (
          <Button
            type="submit"
            size="icon"
            className="h-8 w-8 transition-opacity"
            aria-label="Send message"
            disabled={(props as any).value === '' || isGenerating}
          >
            <ArrowUp className="h-5 w-5" />
          </Button>
        )}
      </div>

      {(props as any).allowAttachments && <FileUploadOverlay isDragging={isDragging} />}

      <RecordingControls
        isRecording={isRecording}
        isTranscribing={isTranscribing}
        audioStream={audioStream}
        textAreaHeight={textAreaHeight}
        onStopRecording={stopRecording}
      />

      {/* Bottom toolbar (inside container) */}
      <div className="absolute inset-x-3 bottom-1 flex items-center justify-between text-muted-foreground">
        <div className="flex items-center gap-1">
          {leftExtras}
          {(props as any).allowAttachments && (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="h-8 w-8"
              aria-label="Attach a file"
              onClick={async () => {
                const files = await showFileUploadDialog()
                addFiles(files)
              }}
            >
              <Paperclip className="h-4 w-4" />
            </Button>
          )}
          {isSpeechSupported && (
            <Button
              type="button"
              variant="ghost"
              className={cn('h-8 w-8', isListening && 'text-primary')}
              aria-label="Voice input"
              size="icon"
              onClick={toggleListening}
            >
              <Mic className="h-4 w-4" />
            </Button>
          )}
        </div>
        <div className="flex items-center gap-2">{/* 预留右侧区域（如快捷提示/统计） */}</div>
      </div>
    </div>
  )
}
MessageInput.displayName = 'MessageInput'

interface FileUploadOverlayProps {
  isDragging: boolean
}
function FileUploadOverlay({ isDragging }: FileUploadOverlayProps) {
  return (
    <AnimatePresence>
      {isDragging && (
        <motion.div
          className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center space-x-2 rounded-xl border border-dashed border-border bg-background text-sm text-muted-foreground"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          aria-hidden
        >
          <Paperclip className="h-4 w-4" />
          <span>Drop your files here to attach them.</span>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function showFileUploadDialog() {
  const input = document.createElement('input')
  input.type = 'file'
  input.multiple = true
  input.accept = '*/*'
  input.click()
  return new Promise<File[] | null>((resolve) => {
    input.onchange = (e) => {
      const files = (e.currentTarget as HTMLInputElement).files
      if (files) {
        resolve(Array.from(files))
        return
      }
      resolve(null)
    }
  })
}

interface RecordingPromptProps {
  isVisible: boolean
  onStopRecording: () => void
}
function RecordingPrompt({ isVisible, onStopRecording }: RecordingPromptProps) {
  return (
    <AnimatePresence>
      {isVisible && (
        <motion.div
          initial={{ top: 0, filter: 'blur(5px)' }}
          animate={{
            top: -40,
            filter: 'blur(0px)',
            transition: { type: 'spring', filter: { type: 'tween' } }
          }}
          exit={{ top: 0, filter: 'blur(5px)' }}
          className="absolute left-1/2 flex -translate-x-1/2 cursor-pointer overflow-hidden whitespace-nowrap rounded-full border bg-background py-1 text-center text-sm text-muted-foreground"
          onClick={onStopRecording}
        >
          <span className="mx-2.5 flex items-center">
            <Info className="mr-2 h-3 w-3" />
            Click to finish recording
          </span>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

interface RecordingControlsProps {
  isRecording: boolean
  isTranscribing: boolean
  audioStream: MediaStream | null
  textAreaHeight: number
  onStopRecording: () => void
}
function RecordingControls({
  isRecording,
  isTranscribing,
  audioStream,
  textAreaHeight,
  onStopRecording
}: RecordingControlsProps) {
  if (isRecording) {
    return (
      <div
        className="absolute inset-[1px] z-50 overflow-hidden rounded-xl"
        style={{ height: textAreaHeight - 2 }}
      >
        <AudioVisualizer stream={audioStream} isRecording={isRecording} onClick={onStopRecording} />
      </div>
    )
  }
  if (isTranscribing) {
    return (
      <div
        className="absolute inset-[1px] z-50 overflow-hidden rounded-xl"
        style={{ height: textAreaHeight - 2 }}
      >
        <TranscribingOverlay />
      </div>
    )
  }
  return null
}

function TranscribingOverlay() {
  return (
    <motion.div
      className="flex h-full w-full flex-col items-center justify-center rounded-xl bg-background/80 backdrop-blur-sm"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
    >
      <div className="relative">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <motion.div
          className="absolute inset-0 h-8 w-8 animate-pulse rounded-full bg-primary/20"
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1.2, opacity: 1 }}
          transition={{ duration: 1, repeat: Infinity, repeatType: 'reverse', ease: 'easeInOut' }}
        />
      </div>
      <p className="mt-4 text-sm font-medium text-muted-foreground">Transcribing audio...</p>
    </motion.div>
  )
}
