export interface ChatItem {
  kind: 'user' | 'assistant' | 'tool' | 'command'
  /** for kind = command: the arguments typed after the command */
  text: string
  /** tool name (kind = tool) or slash command without "/" (kind = command) */
  tool?: string
  input?: string
  /** tool result, or what a slash command printed */
  result?: string
  error?: boolean
  /** kind = user: attached images – data: URLs (pasted into the CLI) or Hive attachment paths */
  images?: string[]
  at: number
}

export interface Conversation {
  items: ChatItem[]
  /** tokens in the context window after the last reply */
  context: { used: number; window: number; model: string } | null
}
