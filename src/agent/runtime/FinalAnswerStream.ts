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
  fallbackAnswerText: string;
  hiddenText: string;
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
  const lowerCloseTag = FINAL_ANSWER_CLOSE_TAG.toLowerCase();
  const maxSuffix = Math.min(buffer.length, FINAL_ANSWER_CLOSE_TAG.length - 1);

  for (let length = maxSuffix; length > 0; length -= 1) {
    if (lowerCloseTag.startsWith(lowerBuffer.slice(-length))) {
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
  private phase: "before_answer" | "answer" | "after_answer" = "before_answer";

  get hasStartedAnswer(): boolean {
    return this.phase === "answer" || this.phase === "after_answer";
  }

  push(text: string): FinalAnswerStreamChunk {
    if (!text) {
      return emptyChunk();
    }

    if (this.phase === "after_answer") {
      return {
        ...emptyChunk(),
        hiddenText: text,
      };
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
      const fallbackAnswerText = stripFinalAnswerProtocolTags(this.beforeAnswerBuffer);
      this.beforeAnswerBuffer = "";
      return {
        answerText: "",
        fallbackAnswerText,
        hiddenText: "",
      };
    }

    if (this.phase === "answer") {
      const answerText = stripTrailingCloseTagPrefix(this.answerBuffer);
      this.answerBuffer = "";
      this.phase = "after_answer";
      return {
        answerText,
        fallbackAnswerText: "",
        hiddenText: "",
      };
    }

    return {
      answerText: "",
      fallbackAnswerText: "",
      hiddenText: "",
    };
  }

  private consumeAnswerText(text: string): FinalAnswerStreamChunk {
    if (!text) {
      return emptyChunk();
    }

    this.answerBuffer += text;
    const closeIndex = indexOfIgnoreCase(this.answerBuffer, FINAL_ANSWER_CLOSE_TAG);

    if (closeIndex >= 0) {
      const answerText = this.answerBuffer.slice(0, closeIndex);
      const hiddenText = this.answerBuffer.slice(
        closeIndex + FINAL_ANSWER_CLOSE_TAG.length,
      );
      this.answerBuffer = "";
      this.phase = "after_answer";
      return {
        answerClosed: true,
        answerStarted: false,
        answerText,
        hiddenText,
      };
    }

    const safeLength = safeAnswerEmitLength(this.answerBuffer);
    const answerText = this.answerBuffer.slice(0, safeLength);
    this.answerBuffer = this.answerBuffer.slice(safeLength);
    return {
      answerClosed: false,
      answerStarted: false,
      answerText,
      hiddenText: "",
    };
  }
}
