import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'

/** 企微把选择放在每一道题的 option_ids.option_id 里。 */
function optionIdsOf(event: Record<string, unknown>, questionKey: string): string[] {
  const items = (event.selected_items as { selected_item?: unknown } | undefined)?.selected_item
  if (!Array.isArray(items)) {
    return event.question_key === undefined || event.question_key === questionKey
      ? stringIds(event.option_ids)
      : []
  }
  return items.flatMap((item) => {
    const choice = item as { question_key?: string; option_ids?: { option_id?: unknown } } | null
    return choice?.question_key === questionKey ? stringIds(choice.option_ids?.option_id) : []
  })
}

function stringIds(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []
}

/** Demo vote card for `/card`: vertical options read better than a button row. */
function buildDemoVoteCard(): TemplateCard {
  return {
    card_type: 'vote_interaction',
    task_id: `demo-${randomUUID()}`,
    main_title: { title: '卡片连通性测试', desc: '单选' },
    sub_title_text: '选一项后点提交，机器人会回复「收到」。',
    checkbox: {
      question_key: 'demo_q1',
      mode: 0,
      option_list: [
        { id: 'opt_a', text: '选项 A' },
        { id: 'opt_b', text: '选项 B' },
        { id: 'opt_c', text: '以上都不是' },
      ],
    },
    submit_button: { text: '提交', key: 'demo_submit' },
  }
}

/** Closing line appended to every reply so the 👍/👎 loop gets used. */
export const FEEDBACK_FOOTER = '\n\n———\n如果回答准确，请点 👍；如果回答不好，请点 👎 反馈，谢谢。'

/** WeCom negative-feedback reason ids -> labels (feedback-event docs). */
const NEGATIVE_REASON_LABELS: Record<number, string> = {
  1: '与内容无关',
  2: '内容不完整',
  3: '内容有错误',
  4: '数据分析错误',
}

import { readFile } from 'node:fs/promises'
import { basename, isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  type BaseMessage,
  type EnterChatEvent,
  type EventMessageWith,
  type FeedbackEventData,
  generateReqId,
  type Logger,
  type ReplyMsgItem,
  type TemplateCard,
  type TemplateCardEventData,
  type WeComMediaType,
  WSAuthFailureError,
  WSClient,
  type WSClientOptions,
  WSReconnectExhaustedError,
  type WsFrame,
  type WsFrameHeaders,
} from '@wecom/aibot-node-sdk'
import type { ResolvedConfig, WecomIdentity } from './config.js'
import { clipUtf8, Dedupe, replyTarget, timeout } from './helpers.js'
import { AgentPool, type Reply } from './pool.js'

/** The user-feedback payload WeCom sends, which the SDK event type does not declare. */
export interface WecomFeedbackEvent {
  /** Feedback id echoed from the reply's `stream.feedback.id`. */
  readonly id: string
  /** `1` = 👍, `2` = 👎, `3` = cancelled. */
  readonly type: 1 | 2 | 3
  /** Optional free text the user attached to the rating. */
  readonly content?: string
  /** Optional 👎 reason codes (1-4). */
  readonly inaccurate_reason_list?: readonly number[]
}

/** `event.feedback_event` content: the SDK's `eventtype` plus the payload WeCom actually sends. */
export type FeedbackEventContent = FeedbackEventData & { feedback_event?: WecomFeedbackEvent }

/** `event.template_card_event` content: the SDK's `eventtype` plus WeCom's payload. */
export type TemplateCardEventContent = TemplateCardEventData & {
  template_card_event?: Record<string, unknown>
}

type QuestionAnswer = { answers: { id: string; selected: string[] }[] }
type QuestionFallback = () => Promise<QuestionAnswer>

interface QuestionRequest {
  agent?: { session: { id: string } }
  questions: {
    id: string
    question: string
    detail?: string
    options?: { label: string }[]
    multiSelect?: boolean
    intent?: unknown
  }[]
  signal?: AbortSignal
  wait?: { timed?: boolean }
}

interface PendingQuestion {
  card: TemplateCard
  sessionId: string
  recipient: WecomIdentity
  settle: (label?: string) => void
}

type QuestionEvents = {
  on(
    event: 'user-questions/request',
    handler: (request: QuestionRequest, next: QuestionFallback) => Promise<QuestionAnswer>,
    options: { global: true; prepend: true },
  ): () => void
}

/** The subset of the official SDK this channel calls (kept minimal for test doubles). */
export interface BotClient {
  readonly isConnected: boolean
  on(event: 'connected' | 'authenticated', handler: () => void): this
  on(event: 'disconnected', handler: (reason: string) => void): this
  on(event: 'reconnecting', handler: (attempt: number) => void): this
  on(event: 'error', handler: (error: Error) => void): this
  on(event: 'message', handler: (frame: WsFrame<BaseMessage>) => void | Promise<void>): this
  on(
    event: 'event.enter_chat',
    handler: (frame: WsFrame<EventMessageWith<EnterChatEvent>>) => void | Promise<void>,
  ): this
  on(
    event: 'event.feedback_event',
    handler: (frame: WsFrame<EventMessageWith<FeedbackEventContent>>) => void | Promise<void>,
  ): this
  on(
    event: 'event.template_card_event',
    handler: (frame: WsFrame<EventMessageWith<TemplateCardEventContent>>) => void | Promise<void>,
  ): this
  on(event: 'event.disconnected_event', handler: () => void): this
  connect(): this
  disconnect(): void
  sendMessage(
    chatid: string,
    body:
      | { msgtype: 'markdown'; markdown: { content: string } }
      | { msgtype: 'template_card'; template_card: TemplateCard },
  ): Promise<unknown>
  replyStream(
    frame: WsFrameHeaders,
    streamId: string,
    content: string,
    finish?: boolean,
    msgItem?: readonly ReplyMsgItem[],
    feedback?: { id: string },
  ): Promise<unknown>
  replyWelcome(
    frame: WsFrameHeaders,
    body: { msgtype: 'text'; text: { content: string } },
  ): Promise<unknown>
  replyTemplateCard(frame: WsFrameHeaders, card: TemplateCard): Promise<unknown>
  updateTemplateCard(frame: WsFrameHeaders, card: TemplateCard): Promise<unknown>
  uploadMedia(
    fileBuffer: Uint8Array,
    options: { type: WeComMediaType; filename: string },
  ): Promise<{ media_id: string }>
  sendMediaMessage(chatid: string, mediaType: WeComMediaType, mediaId: string): Promise<unknown>
  downloadFile(url: string, aesKey?: string): Promise<{ buffer: Uint8Array; filename?: string }>
}

export type BotClientFactory = (options: WSClientOptions) => BotClient

/** JSON-safe point-in-time health of the WeCom channel. */
export interface ChannelStatus {
  /** Whether the long connection is currently open. */
  connected: boolean
  /** Whether the channel is tearing down. */
  stopping: boolean
  /** Number of live conversation agents held by the pool. */
  conversations: number
  /** Epoch ms of the last successful authentication, or null before it. */
  authenticatedAt: number | null
  /** Message of the most recent connection error, or null when none. */
  lastError: string | null
}

/** Status access consumed by dashboards and other UI surfaces. */
export interface ChannelStatusService {
  snapshot(): ChannelStatus
  /** Force the long connection to reconnect now (console restart control). */
  reconnect?(): void
}

const COMMANDS = new Set([
  '/ping',
  '/help',
  '/card',
  '/status',
  '/stop',
  '/compact',
  '/new',
  '/clear',
  '/session',
  '/sessions',
  '/current',
  '/resume',
])

/**
 * Assemble one WeCom stream frame from reasoning and visible text. The WeCom
 * client converts the FIRST `<think>…</think>` block into its native
 * "思考过程" card, so reasoning rides inside the tag: while only reasoning
 * exists the tag stays OPEN (the client shows the thinking state); it closes
 * once visible text arrives or the stream finishes. Nested/foreign think tags
 * in the model output are stripped so the client always sees exactly one.
 */
export function buildStreamContent(
  reasoningText: string,
  visibleText: string,
  finish: boolean,
): string {
  const reasoning = reasoningText
    .replace(/<\s*\/?\s*(?:think(?:ing)?|thought)\b[^<>]*>/gi, '')
    .trim()
  const visible = visibleText.trim()
  if (!reasoning) return visible
  const think = finish || visible ? `<think>${reasoning}</think>` : `<think>${reasoning}`
  return visible ? `${think}\n${visible}` : think
}

/**
 * Accumulates streamed model deltas (visible text + reasoning) and flushes the
 * growing full content to WeCom on a throttle. WeCom's stream reply REPLACES
 * the message content on every frame (same stream id), so each flush sends the
 * complete accumulated content, never a delta. The final `finish: true` frame
 * is sent separately by the caller and carries the authoritative reply text.
 */
class StreamSink {
  private text = ''
  private reasoning = ''
  private timer: ReturnType<typeof setTimeout> | undefined
  private lastSent = ''

  constructor(
    private readonly send: (content: string, finish: boolean) => Promise<void>,
    private readonly flushMs: number,
    private readonly limitBytes: number,
    private readonly onError: (error: unknown) => void,
  ) {}

  push(kind: 'text' | 'reasoning', delta: string): void {
    if (!delta) return
    if (kind === 'reasoning') this.reasoning += delta
    else this.text += delta
    if (this.timer === undefined) {
      this.timer = setTimeout(() => {
        this.timer = undefined
        void this.flush(false).catch(this.onError)
      }, this.flushMs)
    }
  }

  async flush(finish: boolean): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    const content = clipUtf8(buildStreamContent(this.reasoning, this.text, finish), this.limitBytes)
    if (!finish && (content === '' || content === this.lastSent)) return
    this.lastSent = content
    await this.send(content, finish)
  }
}

/** Truncate to at most `max` characters, keeping the head. */
function elideHead(value: string, max: number): string {
  const trimmed = value.trim()
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`
}

/**
 * Append one turn failure with its STACK to a file so a swallowed failure is
 * diagnosable after the fact (the plugin logger does not reach the service
 * journal). Path: `DSH_WECOM_ERROR_LOG` or `/tmp/dsh-wecom-error.log`.
 * Best-effort — diagnostics must never break the reply path.
 */
function logTurnFailure(message: BaseMessage, error: unknown): void {
  try {
    const file = process.env.DSH_WECOM_ERROR_LOG ?? '/tmp/dsh-wecom-error.log'
    const stack = error instanceof Error ? (error.stack ?? error.message) : String(error)
    appendFileSync(
      file,
      `${new Date().toISOString()} msgid=${message.msgid} chattype=${message.chattype}\n${stack}\n\n`,
    )
  } catch {
    /* diagnostics are best-effort */
  }
}

/** Truncate to at most `max` characters, keeping the tail (most recent reasoning). */
function elideTail(value: string, max: number): string {
  const trimmed = value.trim()
  return trimmed.length <= max ? trimmed : `…${trimmed.slice(trimmed.length - max)}`
}

/**
 * A compact, readable preview of one tool call's arguments: the most
 * informative scalar field when the JSON parses, otherwise the raw string,
 * flattened and truncated.
 */
function toolArgPreview(argumentsJson: string, max: number): string {
  let value = ''
  try {
    const parsed = JSON.parse(argumentsJson) as Record<string, unknown>
    for (const key of ['command', 'file_path', 'path', 'name', 'query', 'text']) {
      const candidate = parsed[key]
      if (typeof candidate === 'string' && candidate.trim()) {
        value = candidate
        break
      }
    }
  } catch {
    // Not JSON — fall back to the raw string below.
  }
  return elideHead((value || argumentsJson).replace(/\s+/g, ' '), max)
}

/** Owns the WeCom WebSocket and funnels each message into a Harness agent. */
export class WecomChannel {
  private readonly log
  private readonly pool: AgentPool
  private readonly dedupe: Dedupe
  private client: BotClient | undefined
  private stopping = false
  private authenticatedAt: number | null = null
  private lastError: string | null = null
  private disposeQuestionListener?: () => void
  private readonly pendingQuestions = new Map<string, PendingQuestion>()
  /** Resolved when the connection is unrecoverable or the channel stops. */
  private dead = Promise.withResolvers<void>()

  constructor(
    private readonly ctx: Context,
    private readonly config: ResolvedConfig,
    private readonly clientFactory: BotClientFactory = (options) => new WSClient(options),
  ) {
    if (!isAbsolute(config.cwd)) {
      throw new Error(`dsh-wecom: cwd must be absolute, got ${JSON.stringify(config.cwd)}`)
    }
    this.log = ctx.logger('dsh-wecom')
    this.pool = new AgentPool(ctx, config)
    this.dedupe = new Dedupe(config.dedupeLimit)
    // In-chat approval seam: the pool claims WeCom-agent escalations and
    // pushes the ask into the chat; incoming reply words are intercepted
    // BEFORE the normal message flow (the waiting turn must not queue the
    // answer behind itself).
    this.interceptApprovalReply = this.pool.wireApprovals(async (sessionId, text) => {
      await this.pushToSession(sessionId, text)
    })
  }

  /** Reply interceptor installed by the pool in the constructor. */
  private readonly interceptApprovalReply: (
    message: BaseMessage,
  ) => 'allowed-once' | 'rejected' | undefined

  /** Connect and authenticate before accepting any traffic. */
  async start(): Promise<void> {
    this.dead = Promise.withResolvers<void>()
    await this.pool.start()
    const resolved = await this.ctx.credentials.resolve(credentialRef(this.config.credentialName))
    if (resolved === undefined) {
      throw new Error(
        `dsh-wecom: credential ${JSON.stringify(this.config.credentialName)} is not configured`,
      )
    }
    const client = this.openClient(resolved.value)
    this.client = client

    const ready = Promise.withResolvers<void>()
    let readySettled = false
    const resolveReady = (): void => {
      if (readySettled) return
      readySettled = true
      ready.resolve()
    }
    const rejectReady = (error: Error): void => {
      if (readySettled) return
      readySettled = true
      ready.reject(error)
    }

    client.on('connected', () => this.log.info('WeCom WebSocket connected; authenticating'))
    client.on('authenticated', () => {
      this.authenticatedAt = Date.now()
      // A successful (re)connect clears the sticky error: the panel must not
      // keep showing a failure the channel already recovered from. The
      // recovered message is logged first so the incident stays traceable.
      if (this.lastError !== null) {
        this.log.info('WeCom recovered after: %s', this.lastError)
        this.lastError = null
      }
      resolveReady()
    })
    client.on('disconnected', (reason) => {
      if (!this.stopping) this.log.warn('WeCom WebSocket disconnected: %s', reason)
    })
    client.on('reconnecting', (attempt) =>
      this.log.warn('WeCom WebSocket reconnect attempt %d', attempt),
    )
    client.on('error', (error) => {
      if (!this.stopping) {
        this.lastError = error.message
        this.log.error('WeCom WebSocket error: %s', error.message)
      }
      if (error instanceof WSAuthFailureError || error instanceof WSReconnectExhaustedError) {
        rejectReady(error)
        this.dead.resolve()
      }
    })
    client.on('event.disconnected_event', () => {
      if (!this.stopping) {
        this.lastError = 'Connection replaced by another client for this Bot ID'
        this.log.error(this.lastError)
      }
      // Another client took the bot. Reclaim it: the owning loop restarts us.
      this.dead.resolve()
    })
    client.on('message', async (frame) => this.onMessage(frame))
    client.on('event.enter_chat', async (frame) => this.greet(frame))
    client.on('event.feedback_event', async (frame) => this.onFeedback(frame))
    client.on('event.template_card_event', async (frame) => this.onTemplateCardEvent(frame))

    try {
      client.connect()
      await timeout(ready.promise, this.config.connectTimeoutMs, 'WeCom authentication')
      this.log.info('WeCom AI Bot authenticated for Bot ID %s', this.config.botId)
      // 老版编译依赖缺少事件类型，部署的 DSH 已提供问答事件。
      this.disposeQuestionListener ??= (this.ctx as unknown as QuestionEvents).on(
        'user-questions/request',
        (request, next) => this.onQuestionRequest(request, next),
        { global: true, prepend: true },
      )
    } catch (error) {
      await this.stop()
      throw error
    }
  }

  /** Drop the socket and shut down the agent pool. */
  async stop(): Promise<void> {
    if (this.stopping) return
    this.stopping = true
    this.disposeQuestionListener?.()
    this.disposeQuestionListener = undefined
    for (const question of this.pendingQuestions.values()) question.settle()
    this.dead.resolve()
    this.client?.disconnect()
    await this.pool.dispose()
  }

  /**
   * Force an immediate reconnect: drop the current socket and wake the owning
   * restart loop, which re-runs {@link start} after `restartIntervalMs`. The
   * channel stays non-stopping, so the bot comes back on its own — this is the
   * "restart the long connection now" control, not a shutdown. A no-op while
   * stopping.
   */
  reconnect(): void {
    if (this.stopping) return
    this.client?.disconnect()
    this.dead.resolve()
  }

  /** Resolves when the connection becomes unrecoverable or `stop()` runs. */
  untilDead(): Promise<void> {
    return this.dead.promise
  }

  /** Point-in-time health for dashboards; scalar fields only, no live objects. */
  snapshot(): ChannelStatus {
    return {
      connected: this.client?.isConnected ?? false,
      stopping: this.stopping,
      conversations: this.pool.size(),
      authenticatedAt: this.authenticatedAt,
      lastError: this.lastError,
    }
  }

  /** Display peer (userid or chatid) of one conversation, when known. */
  peerOf(sessionId: string): string | undefined {
    return this.pool.peerOf(sessionId)
  }

  private openClient(secret: string): BotClient {
    const sdkLogger: Logger = {
      debug: (message, ...args) => this.log.debug(message, ...args),
      info: (message, ...args) => this.log.info(message, ...args),
      warn: (message, ...args) => this.log.warn(message, ...args),
      error: (message, ...args) => this.log.error(message, ...args),
    }
    return this.clientFactory({
      botId: this.config.botId,
      secret,
      wsUrl: this.config.wsUrl,
      logger: sdkLogger,
      reconnectInterval: this.config.reconnectIntervalMs,
      maxReconnectAttempts: this.config.maxReconnectAttempts,
      maxAuthFailureAttempts: this.config.maxAuthFailureAttempts,
      requestTimeout: this.config.sendTimeoutMs,
    })
  }

  private async greet(frame: WsFrame<EventMessageWith<EnterChatEvent>>): Promise<void> {
    if (!this.config.greeting.trim()) return
    try {
      await timeout(
        this.liveClient().replyWelcome(frame, {
          msgtype: 'text',
          text: { content: clipUtf8(this.config.greeting, this.config.replyLimitBytes) },
        }),
        this.config.sendTimeoutMs,
        'WeCom welcome reply',
      )
    } catch (error) {
      this.log.error('WeCom welcome reply failed: %s', String(error))
    }
  }

  /**
   * Handle one WeCom user-feedback event (👍/👎 on an earlier reply). WeCom only
   * emits these for replies marked with a feedback id, so this is a no-op unless
   * `feedbackMode` is `log`. The verdict fields live in `event.feedback_event`,
   * which the SDK's typed event declares only as an `eventtype`.
   */
  private async onFeedback(frame: WsFrame<EventMessageWith<FeedbackEventContent>>): Promise<void> {
    if (this.config.feedbackMode !== 'log') return
    const body = frame.body
    if (body === undefined) return
    const feedback = body.event.feedback_event
    if (feedback === undefined) return
    if (typeof feedback.id !== 'string' || feedback.id.length === 0) return
    if (feedback.type !== 1 && feedback.type !== 2 && feedback.type !== 3) return
    const payload: Record<string, unknown> = {
      feedbackId: feedback.id,
      type: feedback.type,
      userId: body.from.userid,
      chatType: body.chattype,
      chatId: body.chatid,
      createdAt: body.create_time,
    }
    if (typeof feedback.content === 'string') payload.content = feedback.content.slice(0, 2000)
    if (Array.isArray(feedback.inaccurate_reason_list)) {
      // WeCom sends numeric ids here (1 与内容无关 / 2 内容不完整 /
      // 3 内容有错误 / 4 数据分析错误, per the feedback-event docs). Keep the
      // ids for machine filtering and add the labels so trace consumers can
      // read the verdict without a lookup table.
      const ids = feedback.inaccurate_reason_list
      payload.reasonIds = ids
      payload.reasons = ids.map((id) => NEGATIVE_REASON_LABELS[id] ?? `unknown:${id}`)
    }
    const line = JSON.stringify(payload)
    this.log.info('WeCom feedback: %s', line)
    // Deployment escape hatch: some hosts route plugin loggers away from the
    // process stderr, so mirror the line to stderr where journald can see it.
    console.error('[wecom-feedback] %s', line)
    // Emit on the channel's own context so sibling plugins (tracing, ratings)
    // can consume the verdict without scraping stderr.
    try {
      // The channel event is not part of cordis' typed `Events`; a narrow cast
      // keeps the emit without widening the shared event map for every plugin.
      const emitter = this.ctx as unknown as { emit: (name: string, ...args: unknown[]) => void }
      emitter.emit('wecom-feedback', payload)
    } catch (error) {
      this.log.debug('wecom-feedback emit failed: %s', String(error))
    }
  }

  private async onMessage(frame: WsFrame<BaseMessage>): Promise<void> {
    const message = frame.body
    if (message === undefined || this.dedupe.seen(message.msgid) || !this.permits(message)) return

    // Approval replies answer a pending escalation of THIS chat; they are
    // consumed here and never reach the agent turn (which is still waiting
    // on the escalation's approval request). Deliberately sent through the
    // PROACTIVE channel (sendMessage), never the passive reply stream: the
    // conversation's own turn still holds an open passive stream for its
    // pending reply, and a second passive stream on another message of the
    // same chat can displace it — the turn's final reply then never reaches
    // the user (observed in production).
    const outcome = this.interceptApprovalReply(message)
    if (outcome !== undefined) {
      const text = outcome === 'allowed-once' ? '已批准，继续执行。' : '已拒绝，该操作不会执行。'
      try {
        await this.pushToChatOf(message, text)
      } catch (error) {
        this.log.error('WeCom approval ack failed: %s', String(error))
      }
      return
    }

    // Commands match on the FIRST token, so `/resume 2` dispatches like
    // `/resume`; anything after the head becomes its argument string.
    const commandText = commandOf(message)
    const head = commandText.split(/\s+/)[0] ?? ''
    if (COMMANDS.has(head)) {
      await this.onCommand(frame, message, head, commandText.slice(head.length).trim())
      return
    }

    const streamId = generateReqId('dsh')
    const sink = this.config.streaming
      ? new StreamSink(
          (content, finish) => this.sendStreamBestEffort(frame, streamId, content, finish),
          this.config.streamFlushMs,
          this.config.replyLimitBytes,
          (error) => this.log.error('WeCom stream flush failed: %s', String(error)),
        )
      : undefined
    try {
      await this.sendStream(
        frame,
        streamId,
        'Working…',
        false,
        undefined,
        this.config.feedbackMode === 'log' ? { id: streamId } : undefined,
      )
      const reply = await this.pool.handle(
        message,
        (url, aesKey) =>
          this.liveClient()
            .downloadFile(url, aesKey)
            .then((result) => ({ data: result.buffer, filename: result.filename })),
        sink
          ? (delta) => {
              if (delta.kind === 'reasoning' && !this.config.showReasoning) return
              sink.push(delta.kind, delta.text)
            }
          : undefined,
      )
      await sink?.flush(false)
      const finalText = clipUtf8(this.renderReply(reply), this.config.replyLimitBytes)
      try {
        await this.sendStream(frame, streamId, finalText, true)
      } catch (streamError) {
        // The passive stream can die mid-turn (stream window expired — the
        // server answers a non-zero errcode such as 846608 — or the stream was
        // displaced). Fall back to the proactive channel so the finished
        // answer still reaches the user instead of silently vanishing.
        this.log.error(
          'WeCom final stream reply failed (falling back to proactive push): %s',
          String(streamError),
        )
        logTurnFailure(message, streamError)
        try {
          await this.pushToChatOf(message, finalText)
        } catch (pushError) {
          this.log.error('WeCom final stream push fallback failed: %s', String(pushError))
        }
      }
      // Cards ship on their OWN path, after the text landed by whichever route
      // succeeded. They must never sit inside the passive-stream try: a report
      // turn routinely outlives the ~6-minute stream window (846608) while the
      // card is rendered near the end, so a failed final frame used to skip
      // every card — the user got the text and no image.
      try {
        await this.sendCardsAsImages(message, reply)
      } catch (cardError) {
        this.log.error('WeCom card image send failed: %s', String(cardError))
        logTurnFailure(message, cardError)
      }
      // Files declared through `present` ride the same proactive channel as
      // card images: the passive stream reply cannot carry attachments.
      try {
        await this.sendFilesAsMedia(message, reply)
      } catch (fileError) {
        this.log.error('WeCom file send failed: %s', String(fileError))
        logTurnFailure(message, fileError)
      }
    } catch (error) {
      this.log.error('WeCom message %s failed: %s', message.msgid, String(error))
      logTurnFailure(message, error)
      const detail = error instanceof Error ? error.message : String(error)
      try {
        await this.sendStream(
          frame,
          streamId,
          clipUtf8(`Something went wrong: ${detail}`, this.config.replyLimitBytes),
          true,
        )
      } catch (sendError) {
        this.log.error('WeCom error reply failed: %s', String(sendError))
        try {
          await this.pushToChatOf(
            message,
            clipUtf8(`Something went wrong: ${detail}`, this.config.replyLimitBytes),
          )
        } catch (pushError) {
          this.log.error('WeCom error fallback push failed: %s', String(pushError))
        }
      }
    }
  }

  private async onCommand(
    frame: WsFrame<BaseMessage>,
    message: BaseMessage,
    command: string,
    args: string,
  ): Promise<void> {
    const streamId = generateReqId('dsh')
    if (command === '/ping') {
      await this.sendStream(frame, streamId, 'pong — dsh-wecom connected.', true)
      return
    }
    if (command === '/help') {
      await this.sendStream(
        frame,
        streamId,
        [
          'dsh-wecom bot',
          '/ping — connectivity check',
          '/card — send a demo vote card (card interaction test)',
          '/help — list commands',
          '/status — session status',
          '/stop — cancel the current generation',
          '/compact — summarize older history to save context',
          '/new — start a fresh conversation (history is kept)',
          '/clear — alias of /new (clear context, start fresh)',
          "/session — list this chat's sessions (history kept by /new)",
          '/current — show the current session',
          '/resume <n> — switch back to a past session (see /session)',
          'Anything else goes to the current Harness default model.',
        ].join('\n'),
        true,
      )
      return
    }
    if (command === '/card') {
      await this.sendCard(frame, buildDemoVoteCard())
      return
    }
    if (command === '/status') {
      await this.sendStream(
        frame,
        streamId,
        'Long connection healthy; sessions are persisted per single/group chat.',
        true,
      )
      return
    }
    if (command === '/stop') {
      const cancelled = this.pool.cancel(message)
      await this.sendStream(
        frame,
        streamId,
        cancelled ? 'Cancellation requested.' : 'No generation in progress.',
        true,
      )
      return
    }
    if (command === '/compact') {
      const text = await this.pool.compact(message)
      await this.sendStream(frame, streamId, text, true)
      return
    }
    if (command === '/session' || command === '/sessions') {
      await this.sendStream(frame, streamId, await this.renderSessionList(message), true)
      return
    }
    if (command === '/current') {
      await this.sendStream(frame, streamId, await this.renderCurrentSession(message), true)
      return
    }
    if (command === '/resume') {
      await this.sendStream(frame, streamId, await this.pool.resumeSession(message, args), true)
      return
    }
    if (command === '/new' || command === '/clear') {
      const epoch = await this.pool.forget(message)
      await this.sendStream(
        frame,
        streamId,
        `Started a new conversation (#${epoch}). History is kept — /session lists it.`,
        true,
      )
    }
  }

  /**
   * `/session` reply: every historical session of this chat (one row per
   * `/new` epoch), newest first, with the routing session marked. Bounded to
   * 30 rows so a long-lived chat stays under the WeCom reply byte cap.
   */
  private async renderSessionList(message: BaseMessage): Promise<string> {
    const views = await this.pool.listSessions(message)
    if (views.length === 0) {
      return '还没有历史 session；直接发送消息即可开始对话。'
    }
    const cap = 30
    const lines = views.slice(0, cap).map((view) => {
      const facts = [this.formatWhen(view.createdAt)]
      if (view.turns !== null) facts.push(`${view.turns} 轮`)
      facts.push(view.title?.trim() || '（无标题）')
      return `${view.current ? '*' : ' '} #${view.epoch}  ${facts.join(' · ')}`
    })
    const overflow =
      views.length > cap ? [`…另有 ${views.length - cap} 个更早的 session 未列出`] : []
    return [
      `本会话共 ${views.length} 个 session（新→旧，* 为当前）：`,
      ...lines,
      ...overflow,
      '发送 /resume <编号> 切换到历史 session；/new 开新会话。',
    ].join('\n')
  }

  /** `/current` reply: one line about the session new messages route to. */
  private async renderCurrentSession(message: BaseMessage): Promise<string> {
    const view = await this.pool.currentSession(message)
    if (view === undefined) {
      return '当前还没有 session；直接发送消息即可开始对话（/session 可查看历史）。'
    }
    const facts = [`#${view.epoch}`]
    const when = this.formatWhen(view.createdAt)
    if (when !== '') facts.push(`开始于 ${when}`)
    if (view.turns !== null) facts.push(`${view.turns} 轮`)
    if (view.title !== undefined && view.title.trim() !== '') facts.push(view.title.trim())
    return `当前 session：${facts.join(' · ')}\n发送 /session 查看本聊天全部历史。`
  }

  /** `MM-DD HH:mm` in server-local time, or '' when the time is unknown. */
  private formatWhen(createdAt: number | null): string {
    if (createdAt === null) return ''
    const d = new Date(createdAt)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  }

  private permits(message: BaseMessage): boolean {
    if (message.chattype === 'group') {
      if (this.config.groupPolicy === 'disabled') return false
      if (this.config.groupPolicy === 'open') return true
      // Allowlist is scoped by group chatid, not sender userid, so a bot added
      // to an unwanted group stays silent regardless of who mentions it.
      return message.chatid !== undefined && this.config.groupAllowlist.includes(message.chatid)
    }
    if (this.config.dmPolicy === 'disabled') return false
    if (this.config.dmPolicy === 'open') return true
    return this.config.dmAllowlist.includes(message.from.userid)
  }

  private async sendStream(
    frame: WsFrameHeaders,
    streamId: string,
    content: string,
    finish: boolean,
    msgItem?: readonly ReplyMsgItem[],
    feedback?: { id: string },
  ): Promise<void> {
    await this.retry(async () =>
      timeout(
        this.liveClient().replyStream(frame, streamId, content, finish, msgItem, feedback),
        this.config.sendTimeoutMs,
        'WeCom reply send',
      ),
    )
  }

  private readonly sentCards = new Map<string, TemplateCard>()

  private async sendCard(frame: WsFrameHeaders, card: TemplateCard): Promise<void> {
    if (card.task_id !== undefined) {
      this.sentCards.set(card.task_id, card)
      if (this.sentCards.size > 200) {
        const oldest = this.sentCards.keys().next().value
        if (oldest !== undefined) this.sentCards.delete(oldest)
      }
    }
    await this.retry(async () =>
      timeout(
        this.liveClient().replyTemplateCard(frame, card),
        this.config.sendTimeoutMs,
        'WeCom template card send',
      ),
    )
  }

  private async onQuestionRequest(
    request: QuestionRequest,
    next: QuestionFallback,
  ): Promise<QuestionAnswer> {
    const sessionId = request.agent?.session.id
    const [question] = request.questions
    if (sessionId === undefined || question === undefined || request.questions.length !== 1) {
      return next()
    }
    const recipient = this.pool.questionRecipient(sessionId)
    const labels = question.options?.map((option) => option.label) ?? []
    const text = question.detail ? `${question.question}\n${question.detail}` : question.question
    // 只接管能完整显示的单选题。审批、开放题和多题仍交给原有回答端。
    if (
      !this.client?.isConnected ||
      recipient === undefined ||
      question.intent !== undefined ||
      question.multiSelect === true ||
      request.wait?.timed === true ||
      labels.length < 2 ||
      labels.length > 20 ||
      new Set(labels).size !== labels.length ||
      labels.some((label) => label.trim() === '' || [...label].length > 11) ||
      [...text].length > 112
    ) {
      return next()
    }
    const skipped = { answers: [{ id: question.id, selected: [] }] }
    const signal = request.signal
    if (signal?.aborted) return skipped

    const taskId = `ask-${randomUUID()}`
    const card: TemplateCard = {
      task_id: taskId,
      card_type: 'vote_interaction',
      main_title: { title: '请选择' },
      sub_title_text: text,
      checkbox: {
        question_key: 'choice',
        mode: 0,
        option_list: labels.map((label, index) => ({ id: `opt_${index + 1}`, text: label })),
      },
      submit_button: { text: '提交', key: 'submit' },
    }
    const answer = Promise.withResolvers<QuestionAnswer>()
    const settle = (label?: string): void => {
      if (!this.pendingQuestions.delete(taskId)) return
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      console.error('[wecom-question] %s %s', taskId, label === undefined ? 'closed' : 'answered')
      answer.resolve(
        label === undefined
          ? skipped
          : {
              answers: [{ id: question.id, selected: [label] }],
            },
      )
    }
    const onAbort = (): void => settle()
    const timer = setTimeout(onAbort, Math.min(120_000, this.config.turnTimeoutMs))
    timer.unref?.()
    this.pendingQuestions.set(taskId, { card, sessionId, recipient, settle })
    signal?.addEventListener('abort', onAbort, { once: true })

    // 这里沿用原工具的等待 Promise。把点选送回消息队列会排在正在等待的回合后面。
    try {
      const sending = this.liveClient().sendMessage(recipient.userid, {
        msgtype: 'template_card',
        template_card: card,
      })
      void timeout(sending, this.config.sendTimeoutMs, 'WeCom question card send').then(
        () => console.error('[wecom-question] %s sent', taskId),
        (error: unknown) => {
          this.log.warn('WeCom question card send failed: %s', String(error))
          settle()
        },
      )
    } catch (error) {
      this.log.warn('WeCom question card send failed: %s', String(error))
      settle()
    }
    return answer.promise
  }

  private async updateCard(frame: WsFrameHeaders, card: TemplateCard): Promise<void> {
    // 更新只能在点击回调的响应窗口内用该帧提交一次。
    await timeout(
      this.liveClient().updateTemplateCard(frame, card),
      Math.min(5_000, this.config.sendTimeoutMs),
      'WeCom template card update',
    )
  }

  private async onTemplateCardEvent(
    frame: WsFrame<EventMessageWith<TemplateCardEventContent>>,
  ): Promise<void> {
    const body = frame.body
    const event = body?.event.template_card_event
    if (body === undefined || event === undefined || typeof event.task_id !== 'string') return
    const taskId = event.task_id
    const pending = this.pendingQuestions.get(taskId)
    if (pending !== undefined) {
      const single = body.chattype === 'single' || (body.chattype === undefined && !body.chatid)
      if (!single || body.from.userid !== pending.recipient.userid) return
      if (this.pool.questionRecipient(pending.sessionId) !== pending.recipient) {
        pending.settle()
        return
      }
    }
    const original = pending?.card ?? this.sentCards.get(taskId)
    const checkbox = original?.checkbox
    if (original === undefined || checkbox === undefined) return
    const optionIds = optionIdsOf(event, checkbox.question_key)
    if (optionIds.length !== 1) return
    const picked = checkbox.option_list.find((option) => option.id === optionIds[0])
    if (picked === undefined) return

    // 有效选择才消耗待答状态。后续回调无论是否重复携带选项，都不会触发第二次。
    if (pending !== undefined) pending.settle(picked.text)
    else this.sentCards.delete(taskId)
    const locked: TemplateCard = {
      ...original,
      checkbox: {
        ...checkbox,
        disable: true,
        option_list: checkbox.option_list.map((option) => ({
          ...option,
          is_checked: option.id === picked.id,
        })),
      },
      ...(original.submit_button !== undefined
        ? { submit_button: { ...original.submit_button, text: '已提交' } }
        : {}),
    }
    try {
      await this.updateCard(frame, locked)
    } catch (error) {
      this.log.warn('WeCom template card update failed: %s', String(error))
    }
    if (pending !== undefined) return
    // /card 是独立连通性测试。原生工具回合会在收到答案后继续回复。
    try {
      const peer = body.chatid || body.from.userid
      await this.pushToPeer(peer, `收到：${picked.text}`)
    } catch (error) {
      this.log.warn('WeCom template card ack failed: %s', String(error))
    }
  }

  /**
   * Ship the turn's rendered cards as dedicated image messages through the
   * PROACTIVE channel (aibot_send_msg, msgtype=image + media_id), which is the
   * documented WeCom image path. The passive stream reply (aibot_respond_msg)
   * does NOT support msg_item, so images cannot ride the stream. Each card is
   * uploaded to the media library for a temporary media_id, then pushed to the
   * chat; failures are logged and skipped while the text reply still goes out.
   */
  private async sendCardsAsImages(message: BaseMessage, reply: Reply): Promise<void> {
    if (reply.images === undefined || reply.images.length === 0) return
    const peer = replyTarget(message)
    for (const ref of reply.images.slice(0, 10)) {
      try {
        const stored = await this.ctx.attachments.readImage(ref)
        // `readImage` returns a plain Uint8Array, but the SDK's uploadMedia
        // expects a Node Buffer and does `chunk.toString('base64')` — on a
        // Uint8Array that is NOT base64 (it yields "[object Uint8Array]"),
        // which WeCom rejects with `40006 invalid file size`. Wrap first.
        const uploaded = await this.liveClient().uploadMedia(Buffer.from(stored.data), {
          type: 'image',
          filename: `card-${Date.now()}.png`,
        })
        if (uploaded.media_id === undefined || uploaded.media_id.length === 0) continue
        await this.retry(async () =>
          timeout(
            this.liveClient().sendMediaMessage(peer, 'image', uploaded.media_id!),
            this.config.sendTimeoutMs,
            'WeCom image push send',
          ),
        )
      } catch (error) {
        this.log.error('WeCom card image send failed: %s', String(error))
      }
    }
  }

  /**
   * Ship files declared through the `present` tool through the PROACTIVE
   * channel (aibot_send_msg + media_id). PNG/JPEG files ≤2MB ride
   * `msgtype=image` so WeCom renders them inline; everything else (and any
   * image that fails to send) goes as a `msgtype=file` card. The passive stream
   * reply cannot carry attachments, so each file is uploaded for a temporary
   * media_id and then pushed to the chat. Failures are logged and skipped while
   * the text reply still goes out.
   */
  private async sendFilesAsMedia(message: BaseMessage, reply: Reply): Promise<void> {
    if (reply.files === undefined || reply.files.length === 0) return
    const peer = replyTarget(message)
    for (const file of reply.files.slice(0, 10)) {
      try {
        const data = Buffer.from(await readFile(file.path))
        const filename = basename(file.path)
        // PNG/JPEG (≤2MB) go through the image message so WeCom renders them
        // inline; everything else (and anything oversized) stays a file card.
        const isImage = /\.(png|jpe?g)$/i.test(filename) && data.length <= 2 * 1024 * 1024
        const sendKind: WeComMediaType = isImage ? 'image' : 'file'
        const uploaded = await this.liveClient().uploadMedia(data, {
          type: sendKind,
          filename,
        })
        if (uploaded.media_id === undefined || uploaded.media_id.length === 0) continue
        await this.retry(async () =>
          timeout(
            this.liveClient().sendMediaMessage(peer, sendKind, uploaded.media_id!),
            this.config.sendTimeoutMs,
            sendKind === 'image' ? 'WeCom image push send' : 'WeCom file push send',
          ),
        )
      } catch (error) {
        this.log.error('WeCom file send failed: %s', String(error))
        // An image upload can fail on size/format limits; fall back to a file
        // card so the user still receives the asset.
        try {
          const fallbackName = basename(file.path)
          if (!/\.(png|jpe?g)$/i.test(fallbackName)) continue
          const fallbackData = Buffer.from(await readFile(file.path))
          const fallbackUploaded = await this.liveClient().uploadMedia(fallbackData, {
            type: 'file',
            filename: fallbackName,
          })
          if (fallbackUploaded.media_id === undefined || fallbackUploaded.media_id.length === 0) {
            continue
          }
          await this.liveClient().sendMediaMessage(peer, 'file', fallbackUploaded.media_id)
        } catch (fallbackError) {
          this.log.error('WeCom file fallback failed: %s', String(fallbackError))
        }
      }
    }
  }

  /**
   * Best-effort stream frame for intermediate text: a dropped or failed frame
   * is fine because the authoritative `finish: true` frame carries everything.
   */
  private async sendStreamBestEffort(
    frame: WsFrameHeaders,
    streamId: string,
    content: string,
    finish: boolean,
  ): Promise<void> {
    try {
      await timeout(
        this.liveClient().replyStream(frame, streamId, content, finish),
        this.config.sendTimeoutMs,
        'WeCom stream reply',
      )
    } catch (error) {
      this.log.error('WeCom stream reply failed: %s', String(error))
    }
  }

  /**
   * The final reply: the native `<think>` card carrying the whole process
   * (reasoning plus tool-call activity), then the clean answer text. The
   * answer gets priority under the WeCom byte cap; the process content is
   * budgeted out of what remains.
   */
  private renderReply(reply: Reply): string {
    const process = this.renderProcess(reply)
    const processBytes = Buffer.byteLength(process) + 16
    // Reserve room for the footer so the budget still clips the answer, not the
    // call to action.
    const footerBytes = Buffer.byteLength(FEEDBACK_FOOTER)
    const textBudget = Math.max(0, this.config.replyLimitBytes - processBytes - footerBytes)
    const body = clipUtf8(reply.text, textBudget) + FEEDBACK_FOOTER
    return buildStreamContent(process, body, true)
  }

  /**
   * Everything that belongs inside the think card: the model reasoning and a
   * compact tool-call activity list. WeCom has no native tool-call element, so
   * tool activity rides inside the think block instead of polluting the reply
   * body.
   */
  private renderProcess(reply: Reply): string {
    const parts: string[] = []
    if (this.config.showReasoning && reply.reasoning) {
      parts.push(elideTail(reply.reasoning, 2_000))
    }
    const tools = this.renderToolCalls(reply)
    if (tools !== '') parts.push(tools)
    return parts.join('\n\n')
  }

  private renderToolCalls(reply: Reply): string {
    if (
      !this.config.showToolCalls ||
      reply.toolCalls === undefined ||
      reply.toolCalls.length === 0
    ) {
      return ''
    }
    const lines = reply.toolCalls.map((call) => {
      const args = toolArgPreview(call.arguments, 80)
      const status = call.ok ? '' : ` (失败${call.error ? `: ${call.error}` : ''})`
      return `- ${call.name}${args ? `: ${args}` : ''}${status}`
    })
    return `工具调用:\n${lines.join('\n')}`
  }

  private async retry<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: unknown
    for (let attempt = 0; attempt <= this.config.sendAttempts; attempt += 1) {
      try {
        return await operation()
      } catch (error) {
        lastError = error
        if (attempt < this.config.sendAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)))
        }
      }
    }
    throw lastError
  }

  private liveClient(): BotClient {
    if (this.client === undefined || !this.client.isConnected) {
      throw new Error('dsh-wecom: client is not connected')
    }
    return this.client
  }

  /**
   * Proactively deliver one text into the chat owning a WeCom session id:
   * the approval push path. The chat target is the pool's stored peer for
   * the session's conversation (userid for single chats, chatid for
   * groups), so the ask lands in the chat that triggered the escalation
   * even though no inbound frame is at hand.
   */
  private async pushToSession(sessionId: string, text: string): Promise<void> {
    const peer = this.pool.peerOf(stripEpochOf(sessionId))
    if (peer === undefined) throw new Error(`dsh-wecom: no chat target known for ${sessionId}`)
    await this.pushToPeer(peer, text)
  }

  /**
   * Proactively deliver one text into the chat a message came from: the same
   * sendMessage channel as {@link pushToSession}, resolving the target from
   * the message itself (used for approval acks, where the inbound frame is
   * at hand).
   */
  private async pushToChatOf(message: BaseMessage, text: string): Promise<void> {
    await this.pushToPeer(replyTarget(message), text)
  }

  private async pushToPeer(peer: string, text: string): Promise<void> {
    await this.retry(async () =>
      timeout(
        this.liveClient().sendMessage(peer, {
          msgtype: 'markdown',
          markdown: { content: clipUtf8(text, this.config.replyLimitBytes) },
        }),
        this.config.sendTimeoutMs,
        'WeCom proactive push',
      ),
    )
  }
}

/** Strip the epoch suffix (`~gN`) from a WeCom session id. */
function stripEpochOf(id: string): string {
  return id.replace(/~g\d+$/, '')
}

function commandOf(message: BaseMessage): string {
  const raw =
    message.msgtype === 'text'
      ? (message.text?.content ?? '')
      : message.msgtype !== 'mixed'
        ? ''
        : (
            (
              message.mixed as
                | {
                    msg_item?: Array<{ msgtype?: string; text?: { content?: string } }>
                  }
                | undefined
            )?.msg_item ?? []
          )
            .filter((item) => item.msgtype === 'text')
            .map((item) => item.text?.content ?? '')
            .join('')
  // Group messages arrive addressed to the bot as "@BotName /cmd …"; the first
  // whitespace token is then the mention, not the command, so a naive
  // split-and-match never recognizes it. Strip ONE leading @mention token
  // (mirrors the hermes adapter) so slash commands work in group chats. Single
  // chats carry no mention, so the strip is a no-op there.
  const text = message.chattype === 'group' ? raw.replace(/^@\S+\s*/, '') : raw
  return text.trim().toLowerCase()
}
