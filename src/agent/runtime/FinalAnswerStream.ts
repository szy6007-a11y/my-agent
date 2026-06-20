const FINAL_ANSWER_OPEN_TAG = "<final_answer>";
const FINAL_ANSWER_CLOSE_TAG = "</final_answer>";

export type FinalAnswerStreamChunk = {
  answerClosed: boolean;
  answerStarted: boolean;
  answerText: string;
  hiddenText: string;
};

export type FinalAnswerStreamFinish = {
  answerText: string;
  /**
   * Deprecated compatibility field. Untagged content is no longer promoted to
   * a final answer; callers should recover the output protocol instead.
   */
  fallbackAnswerText: string;
  hiddenText: string;
  missingFinalAnswerText: string;
};

function emptyChunk(): FinalAnswerStreamChunk {
  return {
    answerClosed: false,
    answerStarted: false,
    answerText: "",
    hiddenText: "",
  };
}

function indexOfIgnoreCase(value: string, search: string): number {
  return value.toLowerCase().indexOf(search.toLowerCase());
}

function safeAnswerEmitLength(buffer: string): number {
  const lowerBuffer = buffer.toLowerCase();
  const tags = [
    FINAL_ANSWER_OPEN_TAG.toLowerCase(),
    FINAL_ANSWER_CLOSE_TAG.toLowerCase(),
  ];
  const maxSuffix = Math.min(
    buffer.length,
    Math.max(...tags.map((tag) => tag.length - 1)),
  );

  for (let length = maxSuffix; length > 0; length -= 1) {
    if (tags.some((tag) => tag.startsWith(lowerBuffer.slice(-length)))) {
      return buffer.length - length;
    }
  }

  return buffer.length;
}

function stripTrailingCloseTagPrefix(buffer: string): string {
  const safeLength = safeAnswerEmitLength(buffer);
  return buffer.slice(0, safeLength);
}

export function stripFinalAnswerProtocolTags(text: string): string {
  return text
    .replace(/<\s*final_answer\s*>/gi, "")
    .replace(/<\s*\/\s*final_answer\s*>/gi, "");
}

export class FinalAnswerStream {
  private answerBuffer = "";
  private beforeAnswerBuffer = "";
  private phase: "before_answer" | "answer" = "before_answer";

  get hasStartedAnswer(): boolean {
    return this.phase === "answer";
  }

  push(text: string): FinalAnswerStreamChunk {
    if (!text) {
      return emptyChunk();
    }

    if (this.phase === "answer") {
      return this.consumeAnswerText(text);
    }

    this.beforeAnswerBuffer += text;
    const openIndex = indexOfIgnoreCase(this.beforeAnswerBuffer, FINAL_ANSWER_OPEN_TAG);
    if (openIndex === -1) {
      return emptyChunk();
    }

    const hiddenText = this.beforeAnswerBuffer.slice(0, openIndex);
    const answerRemainder = this.beforeAnswerBuffer.slice(
      openIndex + FINAL_ANSWER_OPEN_TAG.length,
    );
    this.beforeAnswerBuffer = "";
    this.phase = "answer";

    const answerChunk = this.consumeAnswerText(answerRemainder);
    return {
      ...answerChunk,
      answerStarted: true,
      hiddenText: hiddenText + answerChunk.hiddenText,
    };
  }

  finish(): FinalAnswerStreamFinish {
    if (this.phase === "before_answer") {
      const missingFinalAnswerText = stripFinalAnswerProtocolTags(this.beforeAnswerBuffer);
      this.beforeAnswerBuffer = "";
      return {
        answerText: "",
        fallbackAnswerText: "",
        hiddenText: "",
        missingFinalAnswerText,
      };
    }

    if (this.phase === "answer") {
      const answerText = stripTrailingCloseTagPrefix(this.answerBuffer);
      this.answerBuffer = "";
      return {
        answerText,
        fallbackAnswerText: "",
        hiddenText: "",
        missingFinalAnswerText: "",
      };
    }

    return {
      answerText: "",
      fallbackAnswerText: "",
      hiddenText: "",
      missingFinalAnswerText: "",
    };
  }

  private consumeAnswerText(text: string): FinalAnswerStreamChunk {
    if (!text) {
      return emptyChunk();
    }

    this.answerBuffer += text;
    const answerClosed = /<\s*\/\s*final_answer\s*>/i.test(this.answerBuffer);
    this.answerBuffer = stripFinalAnswerProtocolTags(this.answerBuffer);

    const safeLength = safeAnswerEmitLength(this.answerBuffer);
    const answerText = this.answerBuffer.slice(0, safeLength);
    this.answerBuffer = this.answerBuffer.slice(safeLength);
    return {
      answerClosed,
      answerStarted: false,
      answerText,
      hiddenText: "",
    };
  }
}
