import React from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { cn } from '@/lib/utils'
import { CopyButton } from '@/components/ui/copy-button'

interface MarkdownRendererProps {
  children: string
  className?: string
}

export function MarkdownRenderer({ children, className }: MarkdownRendererProps) {
  // 性能调试开关：禁用 Markdown 解析与代码高亮，退化为纯文本渲染
  const disableMd = (() => {
    try {
      const v = (import.meta as any).env?.VITE_CHAT_MARKDOWN_DISABLE
      if (v == null) return false
      const s = String(v).toLowerCase()
      return s === '1' || s === 'true' || s === 'yes'
    } catch {
      return false
    }
  })()

  if (disableMd) {
    return (
      <div className={cn('space-y-3', className)}>
        <pre className="whitespace-pre-wrap wrap-break-word text-sm">{children}</pre>
      </div>
    )
  }

  return (
    <div className={cn('space-y-3', className)}>
      <Markdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {children}
      </Markdown>
    </div>
  )
}

interface HighlightedPreProps extends React.HTMLAttributes<HTMLPreElement> {
  children: string
  language: string
}

const HighlightedPre: React.FC<HighlightedPreProps> = ({ children, language, ...props }) => {
  const [tokens, setTokens] = React.useState<any[] | null>(null)
  const [ready, setReady] = React.useState(false)

  React.useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const mod: any = await import('shiki')
        const { codeToTokens, bundledLanguages } = mod
        if (!(language in bundledLanguages)) {
          if (alive) setTokens(null)
          return
        }
        const res = await codeToTokens(children, {
          lang: language as keyof typeof bundledLanguages,
          defaultColor: false,
          themes: { light: 'github-light', dark: 'github-dark' }
        })
        if (alive) setTokens(res.tokens)
      } catch {
        if (alive) setTokens(null)
      } finally {
        if (alive) setReady(true)
      }
    })()
    return () => {
      alive = false
    }
  }, [children, language])

  if (!ready || !tokens) {
    return <pre {...props}>{children}</pre>
  }

  return (
    <pre {...props}>
      <code>
        {tokens.map((line: any, lineIndex: number) => (
          <React.Fragment key={lineIndex}>
            <span>
              {line.map((token: any, tokenIndex: number) => {
                const style = typeof token.htmlStyle === 'string' ? undefined : token.htmlStyle

                return (
                  <span
                    key={tokenIndex}
                    className="text-shiki-light bg-shiki-light-bg dark:text-shiki-dark dark:bg-shiki-dark-bg"
                    style={style}
                  >
                    {token.content}
                  </span>
                )
              })}
            </span>
            {lineIndex !== tokens.length - 1 && '\n'}
          </React.Fragment>
        ))}
      </code>
    </pre>
  )
}
HighlightedPre.displayName = 'HighlightedPre'

interface CodeBlockProps extends React.HTMLAttributes<HTMLPreElement> {
  children: React.ReactNode
  className?: string
  language: string
}

const CodeBlock = ({ children, className, language, ...restProps }: CodeBlockProps) => {
  const code = typeof children === 'string' ? children : childrenTakeAllStringContents(children)

  const preClass = cn(
    'overflow-x-scroll rounded-md border bg-background/50 p-4 font-mono text-sm [scrollbar-width:none]',
    className
  )

  return (
    <div className="group/code relative mb-4">
      <HighlightedPre language={language} className={preClass}>
        {code}
      </HighlightedPre>
      <div className="invisible absolute right-2 top-2 flex space-x-1 rounded-lg p-1 opacity-0 transition-all duration-200 group-hover/code:visible group-hover/code:opacity-100">
        <CopyButton content={code} copyMessage="Copied code to clipboard" />
      </div>
    </div>
  )
}

function childrenTakeAllStringContents(element: any): string {
  if (typeof element === 'string') {
    return element
  }

  if (element?.props?.children) {
    let children = element.props.children

    if (Array.isArray(children)) {
      return children.map((child) => childrenTakeAllStringContents(child)).join('')
    } else {
      return childrenTakeAllStringContents(children)
    }
  }

  return ''
}

const COMPONENTS = {
  h1: withClass('h1', 'text-2xl font-semibold'),
  h2: withClass('h2', 'font-semibold text-xl'),
  h3: withClass('h3', 'font-semibold text-lg'),
  h4: withClass('h4', 'font-semibold text-base'),
  h5: withClass('h5', 'font-medium'),
  strong: withClass('strong', 'font-semibold'),
  // 链接颜色继承父级文本颜色，保证在黑色/深色气泡内可读；在浅色环境保持一致。
  a: withClass('a', cn('underline underline-offset-2 text-current hover:opacity-90')),
  blockquote: withClass('blockquote', 'border-l-2 border-primary pl-4'),
  code: ({ children, className, node, ...rest }: any) => {
    const match = /language-(\w+)/.exec(className || '')
    return match ? (
      <CodeBlock className={className} language={match[1]} {...rest}>
        {children}
      </CodeBlock>
    ) : (
      <code
        className={cn(
          'font-mono [:not(pre)>&]:rounded-md [:not(pre)>&]:bg-background/50 [:not(pre)>&]:px-1 [:not(pre)>&]:py-0.5'
        )}
        {...rest}
      >
        {children}
      </code>
    )
  },
  pre: ({ children }: any) => children,
  ol: withClass('ol', 'list-decimal space-y-2 pl-6'),
  ul: withClass('ul', 'list-disc space-y-2 pl-6'),
  li: withClass('li', 'my-1.5'),
  table: withClass(
    'table',
    'w-full border-collapse overflow-y-auto rounded-md border border-foreground/20'
  ),
  th: withClass(
    'th',
    'border border-foreground/20 px-4 py-2 text-left font-bold [&[align=center]]:text-center [&[align=right]]:text-right'
  ),
  td: withClass(
    'td',
    'border border-foreground/20 px-4 py-2 text-left [&[align=center]]:text-center [&[align=right]]:text-right'
  ),
  tr: withClass('tr', 'm-0 border-t p-0 even:bg-muted'),
  p: withClass('p', 'whitespace-pre-wrap'),
  hr: withClass('hr', 'border-foreground/20')
}

function withClass(Tag: keyof JSX.IntrinsicElements, classes: string) {
  const Component = ({ node, ...props }: any) => <Tag className={classes} {...props} />
  Component.displayName = Tag
  return Component
}

export default MarkdownRenderer
