import type { PluginEvent } from "@paperclipai/plugin-sdk";
import type { SlackBlock, SlackMessage } from "./slack-api.js";
import type { EscalationRecord } from "./types.js";

type Payload = Record<string, unknown>;

let dashboardBase = "http://localhost:3100";
let companyPrefix = "";

const APPROVAL_TYPE_LABELS: Record<string, string> = {
  request_board_approval: "보드 승인 요청",
  hire_agent: "에이전트 채용",
  budget_override: "예산 한도 조정",
};

const RECOMMENDED_ACTION_LABELS: Record<string, string> = {
  Approve: "승인",
  Reject: "거절",
};

const ISSUE_STATUS_LABELS: Record<string, string> = {
  todo: "할 일",
  in_progress: "진행 중",
  in_review: "검토 중",
  done: "완료",
  cancelled: "취소됨",
  backlog: "백로그",
};

const ISSUE_PRIORITY_LABELS: Record<string, string> = {
  critical: "긴급",
  high: "높음",
  medium: "보통",
  low: "낮음",
};

export function setBaseUrl(url: string) {
  dashboardBase = url.replace(/\/+$/, "");
}

export function setCompanyPrefix(prefix: string) {
  companyPrefix = String(prefix ?? "").trim().replace(/^\/+|\/+$/g, "");
}

function dashboardPath(...segments: string[]) {
  const path = segments.filter(Boolean).join("/");
  if (companyPrefix) {
    return `${dashboardBase}/${companyPrefix}/${path}`;
  }
  return `${dashboardBase}/${path}`;
}

function labelFor(map: Record<string, string>, value: string) {
  const key = String(value ?? "").trim();
  return map[key] ?? key;
}

function truncate(text: unknown, max = 500): string | null {
  const value = String(text ?? "").trim();
  if (!value) return null;
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function contextFooter(timestamp?: string): Record<string, unknown> {
  const elements: Array<Record<string, unknown>> = [
    { type: "mrkdwn", text: "Paperclip" },
  ];
  if (timestamp) {
    elements.push({ type: "mrkdwn", text: `<!date^${Math.floor(new Date(timestamp).getTime() / 1000)}^{date_short_pretty} {time}|${timestamp}>` });
  }
  return { type: "context", elements };
}

function viewButton(label: string, url: string): Record<string, unknown> {
  return {
    type: "button",
    text: { type: "plain_text", text: label },
    url,
  };
}

function truncatePlainText(text: string, max = 150): string {
  const value = text.trim();
  if (!value) return "";
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

type ApprovalCardMeta = {
  approvalTypeLabel?: string;
  agentName?: string;
  issueIds?: string[];
  recommendedAction?: string;
};

function approvalMetaFields(meta: ApprovalCardMeta): Array<{ type: string; text: string }> {
  const fields: Array<{ type: string; text: string }> = [];
  if (meta.approvalTypeLabel) {
    fields.push({ type: "mrkdwn", text: `*유형*\n${meta.approvalTypeLabel}` });
  }
  if (meta.agentName) {
    fields.push({ type: "mrkdwn", text: `*요청 에이전트*\n${meta.agentName}` });
  }
  if (meta.issueIds?.length) {
    fields.push({ type: "mrkdwn", text: `*연결 이슈*\n${meta.issueIds.join(", ")}` });
  }
  if (meta.recommendedAction) {
    fields.push({ type: "mrkdwn", text: `*권장 조치*\n${meta.recommendedAction}` });
  }
  return fields;
}

/** Card-style Block Kit layout for approval notifications. */
function buildApprovalCardBlocks(options: {
  headerText: string;
  title: string;
  description?: string | null;
  meta: ApprovalCardMeta;
  footerTimestamp?: string;
  actions?: Array<Record<string, unknown>>;
  titleAccessory?: Record<string, unknown>;
  statusContext?: string;
}): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [
    {
      type: "header",
      text: { type: "plain_text", text: truncatePlainText(options.headerText) },
    },
    { type: "divider" },
  ];

  if (options.statusContext) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: options.statusContext }],
    });
  }

  const titleSection: Record<string, unknown> = {
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*제목*\n${options.title}`,
    },
  };
  if (options.titleAccessory) {
    titleSection.accessory = options.titleAccessory;
  }
  blocks.push(titleSection);

  if (options.description) {
    const quoted = options.description.replace(/\n/g, "\n> ");
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*요약*\n> ${quoted}`,
      },
    });
  }

  const fields = approvalMetaFields(options.meta);
  if (fields.length > 0) {
    blocks.push({ type: "section", fields });
  }

  if (options.actions?.length) {
    blocks.push({ type: "divider" });
    blocks.push({ type: "actions", elements: options.actions });
  }

  blocks.push(
    options.footerTimestamp
      ? contextFooter(options.footerTimestamp)
      : { type: "context", elements: [{ type: "mrkdwn", text: "Paperclip" }] },
  );

  return blocks;
}

// --- Block formatting helpers ---

export function formatAsBlocks(text: string, toolName?: string): SlackBlock[] {
  const blocks: SlackBlock[] = [];

  if (toolName) {
    blocks.push({
      type: "context",
      elements: [
        { type: "mrkdwn", text: `Tool: \`${toolName}\`` },
      ],
    });
  }

  const parts = text.split(/(```[\s\S]*?```)/g);
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith("```") && trimmed.endsWith("```")) {
      const inner = trimmed.slice(3, -3).replace(/^\w*\n/, "");
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: `\`\`\`${inner}\`\`\`` },
      });
    } else {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: trimmed },
      });
    }
  }

  return blocks;
}

// --- Event formatters ---

export function formatIssueCreated(event: PluginEvent): SlackMessage {
  const p = event.payload as Payload;
  const identifier = String(p.identifier ?? event.entityId);
  const title = String(p.title ?? "제목 없음");
  const description = truncate(p.description, 300);
  const status = p.status ? String(p.status) : null;
  const priority = p.priority ? String(p.priority) : null;
  const assigneeName = p.assigneeName ? String(p.assigneeName) : null;
  const projectName = p.projectName ? String(p.projectName) : null;

  const fields: Array<{ type: string; text: string }> = [];
  if (status) fields.push({ type: "mrkdwn", text: `*상태*\n\`${labelFor(ISSUE_STATUS_LABELS, status)}\`` });
  if (priority) fields.push({ type: "mrkdwn", text: `*우선순위*\n\`${labelFor(ISSUE_PRIORITY_LABELS, priority)}\`` });
  if (assigneeName) fields.push({ type: "mrkdwn", text: `*담당자*\n${assigneeName}` });
  if (projectName) fields.push({ type: "mrkdwn", text: `*프로젝트*\n${projectName}` });

  const bodyLines = [
    "*새 이슈 생성*",
    `*${identifier}* ${title}`,
  ];
  if (description) {
    bodyLines.push("", "*내용*", `> ${description}`);
  }

  const blocks: Array<Record<string, unknown>> = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: bodyLines.join("\n"),
      },
      accessory: viewButton("이슈 보기", dashboardPath(`issues/${event.entityId}`)),
    },
  ];

  if (fields.length > 0) {
    blocks.push({ type: "section", fields });
  }

  blocks.push(contextFooter(event.occurredAt));

  return {
    text: `새 이슈: ${identifier} - ${title}`,
    blocks,
  };
}

export function formatIssueDone(event: PluginEvent): SlackMessage {
  const p = event.payload as Payload;
  const identifier = String(p.identifier ?? event.entityId);
  const title = String(p.title ?? "");

  const fields: Array<{ type: string; text: string }> = [];
  if (p.status) fields.push({ type: "mrkdwn", text: `*상태*\n\`${labelFor(ISSUE_STATUS_LABELS, String(p.status))}\`` });
  if (p.priority) fields.push({ type: "mrkdwn", text: `*우선순위*\n\`${labelFor(ISSUE_PRIORITY_LABELS, String(p.priority))}\`` });

  const blocks: Array<Record<string, unknown>> = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*이슈 완료* :white_check_mark:\n*${identifier}* ${title} 작업이 완료되었습니다.`,
      },
      accessory: viewButton("이슈 보기", dashboardPath(`issues/${event.entityId}`)),
    },
  ];

  if (fields.length > 0) {
    blocks.push({ type: "section", fields });
  }

  blocks.push(contextFooter(event.occurredAt));

  return {
    text: `이슈 완료: ${identifier}`,
    blocks,
  };
}

export function formatApprovalCreated(event: PluginEvent): SlackMessage {
  const p = event.payload as Payload;
  const approvalType = String(p.type ?? "unknown");
  const approvalId = String(p.approvalId ?? event.entityId);
  const title = truncate(p.title, 200) ?? "제목 없음";
  const description = truncate(p.description ?? p.summary, 800);
  const agentName = p.agentName ? String(p.agentName) : null;
  const recommendedAction = p.recommendedAction
    ? labelFor(RECOMMENDED_ACTION_LABELS, String(p.recommendedAction))
    : null;
  const issueIds = Array.isArray(p.issueIds) ? p.issueIds.map(String) : [];

  const blocks = buildApprovalCardBlocks({
    headerText: "승인 요청",
    title,
    description,
    meta: {
      approvalTypeLabel: labelFor(APPROVAL_TYPE_LABELS, approvalType),
      agentName: agentName ?? undefined,
      issueIds,
      recommendedAction: recommendedAction ?? undefined,
    },
    footerTimestamp: event.occurredAt,
    actions: [
      {
        type: "button",
        text: { type: "plain_text", text: "승인" },
        style: "primary",
        action_id: "approval_approve",
        value: approvalId,
      },
      {
        type: "button",
        text: { type: "plain_text", text: "거절" },
        style: "danger",
        action_id: "approval_reject",
        value: approvalId,
      },
      {
        type: "button",
        text: { type: "plain_text", text: "보기" },
        url: dashboardPath(`approvals/${approvalId}`),
      },
    ],
  });

  return {
    text: `승인 요청: ${title}`,
    blocks,
  };
}

export type ApprovalResolvedContext = {
  title?: string;
  description?: string;
  agentName?: string;
  /** Raw approval type key (e.g. request_board_approval). */
  approvalType?: string;
  /** Localized type label parsed from Slack blocks. */
  approvalTypeLabel?: string;
  issueIds?: string[];
};

/** Pull approval details from the original Slack message blocks. */
export function extractApprovalContextFromBlocks(
  blocks: Array<Record<string, unknown>> | undefined,
): ApprovalResolvedContext {
  if (!blocks?.length) return {};

  let title: string | undefined;
  let description: string | undefined;
  let agentName: string | undefined;
  let approvalTypeLabel: string | undefined;
  let issueIds: string[] = [];

  for (const block of blocks) {
    if (block.type === "section") {
      const text = String((block.text as Record<string, unknown> | undefined)?.text ?? "");
      const titleMatch = text.match(/\*제목\*?:?\*?\s*(?:\n)?(.+?)(?:\n\n|\n\*|$)/s)
        ?? text.match(/\*제목:\*\s*(.+)/);
      if (titleMatch) {
        title = titleMatch[1].trim();
      }

      const contentMatch = text.match(/\*(?:요약|내용)\*\n((?:> .+(?:\n|$))+)/);
      if (contentMatch) {
        description = contentMatch[1]
          .split("\n")
          .map((line) => line.replace(/^>\s?/, ""))
          .join("\n")
          .trim();
      }

      const fields = block.fields as Array<Record<string, unknown>> | undefined;
      if (fields) {
        for (const field of fields) {
          const fieldText = String(field.text ?? "");
          const agentMatch = fieldText.match(/\*요청 에이전트\*\n(.+)/s);
          if (agentMatch) {
            agentName = agentMatch[1].trim();
          }
          const typeMatch = fieldText.match(/\*유형\*\n(.+)/s);
          if (typeMatch) {
            approvalTypeLabel = typeMatch[1].trim();
          }
          const issueMatch = fieldText.match(/\*연결 이슈\*\n(.+)/s);
          if (issueMatch) {
            issueIds = issueMatch[1]
              .split(/,\s*/)
              .map((id) => id.trim())
              .filter(Boolean);
          }
        }
      }
    }
  }

  return { title, description, agentName, approvalTypeLabel, issueIds };
}

export function mergeApprovalResolvedContext(
  fromMessage: ApprovalResolvedContext,
  fromApi: ApprovalResolvedContext,
): ApprovalResolvedContext {
  return {
    title: fromMessage.title ?? fromApi.title,
    description: fromMessage.description ?? fromApi.description,
    agentName: fromMessage.agentName ?? fromApi.agentName,
    approvalType: fromMessage.approvalType ?? fromApi.approvalType,
    approvalTypeLabel: fromMessage.approvalTypeLabel ?? fromApi.approvalTypeLabel,
    issueIds: fromMessage.issueIds?.length ? fromMessage.issueIds : fromApi.issueIds,
  };
}

export function formatApprovalResolved(
  approvalId: string,
  approved: boolean,
  userId: string,
  context: ApprovalResolvedContext = {},
): SlackMessage {
  const action = approved ? "승인됨" : "거절됨";
  const headerText = approved ? "승인 완료" : "승인 거절";
  const title = context.title?.trim() ?? "제목 없음";
  const description = truncate(context.description, 800);
  const agentName = context.agentName?.trim();
  const approvalTypeLabel = context.approvalTypeLabel?.trim()
    ?? (context.approvalType ? labelFor(APPROVAL_TYPE_LABELS, context.approvalType) : undefined);
  const issueIds = (context.issueIds ?? []).filter(Boolean);

  const blocks = buildApprovalCardBlocks({
    headerText,
    title,
    description,
    meta: {
      approvalTypeLabel,
      agentName,
      issueIds,
    },
    statusContext: `${approved ? ":white_check_mark:" : ":x:"} *${action}* · 처리자 <@${userId}>`,
    titleAccessory: viewButton("보기", dashboardPath(`approvals/${approvalId}`)),
  });

  const textParts = [action];
  if (title) textParts.push(title);
  if (issueIds.length > 0) textParts.push(issueIds.join(", "));

  return {
    text: `${textParts.join(" — ")} (<@${userId}>)`,
    blocks,
  };
}

export function formatAgentError(event: PluginEvent): SlackMessage {
  const p = event.payload as Payload;
  const agentName = String(p.agentName ?? p.name ?? event.entityId);
  const errorMessage = String(p.error ?? p.message ?? "알 수 없는 오류");

  return {
    text: `에이전트 오류: ${agentName}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*에이전트 오류* :warning:\n*${agentName}*에서 오류가 발생했습니다.\n\`\`\`${errorMessage.slice(0, 500)}\`\`\``,
        },
      },
      contextFooter(event.occurredAt),
    ],
  };
}

export function formatAgentConnected(event: PluginEvent): SlackMessage {
  const p = event.payload as Payload;
  const agentName = String(p.agentName ?? p.name ?? event.entityId);

  return {
    text: `에이전트 연결: ${agentName}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*에이전트 연결됨* :white_check_mark:\n*${agentName}* 에이전트가 연결되어 작업 준비가 완료되었습니다.`,
        },
      },
      contextFooter(event.occurredAt),
    ],
  };
}

export function formatBudgetThreshold(event: PluginEvent): SlackMessage {
  const p = event.payload as Payload;
  const agentName = String(p.agentName ?? p.name ?? event.entityId);
  const spent = p.spent != null ? String(p.spent) : "?";
  const budget = p.budget != null ? String(p.budget) : "?";
  const pct = p.percentUsed != null ? String(p.percentUsed) : "?";

  return {
    text: `예산 알림: ${agentName} ${pct}%`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*예산 한도 도달* :chart_with_upwards_trend:\n*${agentName}* 예산의 *${pct}%*를 사용했습니다 ($${spent} / $${budget})`,
        },
      },
      contextFooter(event.occurredAt),
    ],
  };
}

export function formatOnboardingMilestone(event: PluginEvent): SlackMessage {
  const p = event.payload as Payload;
  const agentName = String(p.agentName ?? p.name ?? event.entityId);
  const milestone = String(p.milestone ?? "첫 heartbeat");

  return {
    text: `마일스톤: ${agentName} - ${milestone}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*온보딩 마일스톤* :tada:\n*${agentName}* 달성: ${milestone}`,
        },
      },
      contextFooter(event.occurredAt),
    ],
  };
}

export function formatDailyDigest(stats: {
  tasksCompleted: number;
  tasksCreated: number;
  agentsActive: number;
  totalCost: string;
  topAgent: string;
}): SlackMessage {
  return {
    text: `Daily digest: ${stats.tasksCompleted} tasks completed, $${stats.totalCost} spent`,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: "Daily Activity Digest" },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Tasks completed*\n${stats.tasksCompleted}` },
          { type: "mrkdwn", text: `*Tasks created*\n${stats.tasksCreated}` },
          { type: "mrkdwn", text: `*Active agents*\n${stats.agentsActive}` },
          { type: "mrkdwn", text: `*Total cost*\n$${stats.totalCost}` },
        ],
      },
      ...(stats.topAgent
        ? [
            {
              type: "section" as const,
              text: {
                type: "mrkdwn" as const,
                text: `*Top performer:* ${stats.topAgent}`,
              },
            },
          ]
        : []),
      { type: "divider" },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: "Paperclip - Daily Digest" }],
      },
    ],
  };
}

// --- Escalation formatters ---

export function formatEscalationMessage(escalation: EscalationRecord): SlackMessage {
  const blocks: Array<Record<string, unknown>> = [];

  blocks.push({
    type: "header",
    text: { type: "plain_text", text: `Escalation from ${escalation.agentName ?? "Agent"}` },
  });

  const fields: Array<{ type: string; text: string }> = [
    { type: "mrkdwn", text: `*Reason*\n${escalation.reason}` },
  ];
  if (escalation.confidence != null) {
    fields.push({ type: "mrkdwn", text: `*Confidence*\n${escalation.confidence}` });
  }
  blocks.push({ type: "section", fields });

  if (escalation.conversationHistory && escalation.conversationHistory.length > 0) {
    const lastMessages = escalation.conversationHistory.slice(-5);
    const historyText = lastMessages
      .map((msg) => `${msg.role}: ${msg.text}`)
      .join("\n");
    blocks.push({
      type: "context",
      elements: [
        { type: "mrkdwn", text: `*Recent conversation*\n${historyText.slice(0, 2000)}` },
      ],
    });
  }

  if (escalation.agentReasoning) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Agent reasoning*\n${escalation.agentReasoning}`,
      },
    });
  }

  if (escalation.suggestedReply) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Suggested reply*\n> ${escalation.suggestedReply}`,
      },
    });
  }

  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "Use Suggested Reply" },
        style: "primary",
        action_id: "escalation_use_suggested",
        value: escalation.id,
      },
      {
        type: "button",
        text: { type: "plain_text", text: "Reply to Customer" },
        action_id: "escalation_reply",
        value: escalation.id,
      },
      {
        type: "button",
        text: { type: "plain_text", text: "Override Agent" },
        action_id: "escalation_override",
        value: escalation.id,
      },
      {
        type: "button",
        text: { type: "plain_text", text: "Dismiss" },
        style: "danger",
        action_id: "escalation_dismiss",
        value: escalation.id,
      },
    ],
  });

  return {
    text: `Escalation from ${escalation.agentName ?? "Agent"}: ${escalation.reason}`,
    blocks,
  };
}

export function formatEscalationResolved(
  escalationId: string,
  action: string,
  userId: string,
): SlackMessage {
  const emoji = action === "dismiss" || action === "escalation_dismiss" ? ":x:" : ":white_check_mark:";
  const label = action === "escalation_use_suggested"
    ? "Used suggested reply"
    : action === "escalation_override"
      ? "Overrode agent"
      : action === "escalation_dismiss"
        ? "Dismissed"
        : "Replied";

  return {
    text: `Escalation ${label} by ${userId}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `${emoji} *Escalation ${label}* by <@${userId}>`,
        },
      },
    ],
  };
}
