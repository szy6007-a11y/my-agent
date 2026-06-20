import type {
  AskUserQuestion,
  AskUserQuestionAnnotation,
  AskUserQuestionRequest,
  AskUserQuestionResponse,
} from "@/agent/runtime/types";
import type { StoredToolApproval } from "@/agent/sessions/SessionRepository";
import {
  toolError,
  toolSuccess,
  type AgentTool,
  type ToolValidationResult,
} from "@/agent/tools/types";

type AskUserQuestionInput = {
  annotations?: Record<string, AskUserQuestionAnnotation>;
  answers?: Record<string, string>;
  metadata?: Record<string, unknown>;
  questions: AskUserQuestion[];
};

const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 4;
const MIN_OPTIONS = 2;
const MAX_TEXT_LENGTH = 2_000;
const MAX_PREVIEW_LENGTH = 20_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ?
      (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown, fieldName: string, maxLength = MAX_TEXT_LENGTH): string {
  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be a string.`);
  }

  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${fieldName} cannot be empty.`);
  }
  if (trimmed.length > maxLength) {
    throw new Error(`${fieldName} must be at most ${maxLength} characters.`);
  }

  return trimmed;
}

function optionalStringValue(
  value: unknown,
  fieldName: string,
  maxLength = MAX_TEXT_LENGTH,
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  return stringValue(value, fieldName, maxLength);
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function normalizeMetadata(value: unknown): Record<string, unknown> | undefined {
  const record = asRecord(value);
  return record ? { ...record } : undefined;
}

function normalizeQuestions(rawQuestions: unknown): AskUserQuestion[] {
  if (!Array.isArray(rawQuestions)) {
    throw new Error("questions must be an array.");
  }
  if (rawQuestions.length < 1 || rawQuestions.length > MAX_QUESTIONS) {
    throw new Error(`questions must contain 1 to ${MAX_QUESTIONS} items.`);
  }

  const seenQuestions = new Set<string>();

  return rawQuestions.map((rawQuestion, questionIndex) => {
    const questionRecord = asRecord(rawQuestion);
    if (!questionRecord) {
      throw new Error(`questions[${questionIndex}] must be an object.`);
    }

    const question = stringValue(
      questionRecord.question,
      `questions[${questionIndex}].question`,
    );
    if (seenQuestions.has(question)) {
      throw new Error(`questions[${questionIndex}].question must be unique.`);
    }
    seenQuestions.add(question);

    const header = stringValue(questionRecord.header, `questions[${questionIndex}].header`);
    const rawOptions = questionRecord.options;
    if (!Array.isArray(rawOptions)) {
      throw new Error(`questions[${questionIndex}].options must be an array.`);
    }
    if (rawOptions.length < MIN_OPTIONS || rawOptions.length > MAX_OPTIONS) {
      throw new Error(
        `questions[${questionIndex}].options must contain ${MIN_OPTIONS} to ${MAX_OPTIONS} items.`,
      );
    }

    const seenOptions = new Set<string>();
    const options = rawOptions.map((rawOption, optionIndex) => {
      const optionRecord = asRecord(rawOption);
      if (!optionRecord) {
        throw new Error(
          `questions[${questionIndex}].options[${optionIndex}] must be an object.`,
        );
      }

      const label = stringValue(
        optionRecord.label,
        `questions[${questionIndex}].options[${optionIndex}].label`,
      );
      if (seenOptions.has(label)) {
        throw new Error(
          `questions[${questionIndex}].options[${optionIndex}].label must be unique.`,
        );
      }
      seenOptions.add(label);

      const preview = optionalStringValue(
        optionRecord.preview,
        `questions[${questionIndex}].options[${optionIndex}].preview`,
        MAX_PREVIEW_LENGTH,
      );

      return {
        label,
        description: stringValue(
          optionRecord.description,
          `questions[${questionIndex}].options[${optionIndex}].description`,
        ),
        ...(preview ? { preview } : {}),
      };
    });
    const multiSelect =
      booleanValue(questionRecord.multi_select) ?? booleanValue(questionRecord.multiSelect);

    return {
      question,
      header,
      options,
      ...(multiSelect !== undefined ? { multiSelect } : {}),
    };
  });
}

function normalizeAnnotations(value: unknown): Record<string, AskUserQuestionAnnotation> | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(record).flatMap(([question, rawAnnotation]) => {
      const annotation = asRecord(rawAnnotation);
      if (!annotation) {
        return [];
      }

      const notes = optionalStringValue(annotation.notes, `annotations.${question}.notes`);
      const preview = optionalStringValue(
        annotation.preview,
        `annotations.${question}.preview`,
        MAX_PREVIEW_LENGTH,
      );

      return [[question, { ...(notes ? { notes } : {}), ...(preview ? { preview } : {}) }]];
    }),
  );
}

function normalizeAnswers(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(record).map(([question, answer]) => [
      question,
      stringValue(answer, `answers.${question}`),
    ]),
  );
}

function normalizeInput(args: unknown): AskUserQuestionInput {
  const record = asRecord(args);
  if (!record) {
    throw new Error("ask_user_question arguments must be an object.");
  }

  return {
    annotations: normalizeAnnotations(record.annotations),
    answers: normalizeAnswers(record.answers),
    metadata: normalizeMetadata(record.metadata),
    questions: normalizeQuestions(record.questions),
  };
}

function validateInput(args: unknown): ToolValidationResult {
  try {
    normalizeInput(args);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Invalid ask_user_question input.",
    };
  }
}

function decisionResponse(approval: StoredToolApproval): AskUserQuestionResponse | null {
  const decision = asRecord(approval.decision);
  const response = asRecord(decision?.response);
  if (!response) {
    return null;
  }

  const answers = normalizeAnswers(response.answers);
  if (!answers) {
    return null;
  }

  return {
    answers,
    annotations: normalizeAnnotations(response.annotations),
  };
}

function assertAllQuestionsAnswered(
  questions: AskUserQuestion[],
  answers: Record<string, string> | undefined,
) {
  if (!answers) {
    throw new Error("User answers were not provided for ask_user_question.");
  }

  const missing = questions.filter((question) => !answers[question.question]?.trim());
  if (missing.length > 0) {
    throw new Error(`Missing answers for: ${missing.map((item) => item.question).join(", ")}`);
  }
}

function answerSummary(
  questions: AskUserQuestion[],
  answers: Record<string, string>,
  annotations?: Record<string, AskUserQuestionAnnotation>,
) {
  return questions.map((question) => {
    const annotation = annotations?.[question.question];
    return {
      question: question.question,
      answer: answers[question.question],
      ...(annotation?.notes ? { notes: annotation.notes } : {}),
      ...(annotation?.preview ? { preview: annotation.preview } : {}),
    };
  });
}

export const askUserQuestionTool: AgentTool = {
  name: "ask_user_question",
  definition: {
    type: "function",
    function: {
      name: "ask_user_question",
      description:
        "Ask the user one or more short multiple-choice questions when their answer is needed before continuing. The UI supplies an Other option automatically; do not include an Other option yourself.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          metadata: {
            type: "object",
            additionalProperties: true,
            description: "Optional opaque metadata for the runtime or UI.",
          },
          questions: {
            type: "array",
            minItems: 1,
            maxItems: MAX_QUESTIONS,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                question: {
                  type: "string",
                  description: "The precise question the user should answer.",
                },
                header: {
                  type: "string",
                  description: "A short label shown above this question.",
                },
                multi_select: {
                  type: "boolean",
                  description: "Whether the user may select more than one option.",
                },
                options: {
                  type: "array",
                  minItems: MIN_OPTIONS,
                  maxItems: MAX_OPTIONS,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      label: {
                        type: "string",
                        description:
                          "Short option label. Put the recommended option first and append '(Recommended)' when one option is clearly preferred.",
                      },
                      description: {
                        type: "string",
                        description: "One short sentence explaining the impact of this choice.",
                      },
                      preview: {
                        type: "string",
                        description:
                          "Optional preview text, diff, or payload shown when this option is selected.",
                      },
                    },
                    required: ["label", "description"],
                  },
                },
              },
              required: ["question", "header", "options"],
            },
          },
        },
        required: ["questions"],
      },
    },
  },
  isReadOnly: true,
  maxResultSizeChars: 40_000,
  requiresApproval: true,
  requiresUserInteraction: true,
  risk: "read",
  buildApproval(args) {
    const input = normalizeInput(args);
    const request: AskUserQuestionRequest = {
      kind: "ask_user_question",
      questions: input.questions,
      ...(input.metadata ? { metadata: input.metadata } : {}),
    };

    return {
      reason:
        input.questions.length === 1 ?
          "Agent 需要你回答一个问题后继续。"
        : `Agent 需要你回答 ${input.questions.length} 个问题后继续。`,
      request,
    };
  },
  applyApprovalDecision(args, approval) {
    const input = normalizeInput(args);
    const response = decisionResponse(approval);
    if (!response) {
      throw new Error("User answers were not provided for ask_user_question.");
    }
    assertAllQuestionsAnswered(input.questions, response.answers);

    return {
      ...input,
      answers: response.answers,
      annotations: response.annotations,
    };
  },
  async execute(args) {
    let input: AskUserQuestionInput;
    try {
      input = normalizeInput(args);
      assertAllQuestionsAnswered(input.questions, input.answers);
    } catch (error) {
      return toolError(
        error instanceof Error ? error.message : "ask_user_question did not receive answers.",
      );
    }

    return toolSuccess({
      questions: input.questions,
      answers: input.answers,
      ...(input.annotations ? { annotations: input.annotations } : {}),
      summary: answerSummary(input.questions, input.answers ?? {}, input.annotations),
    });
  },
  validateInput,
};
