import assert from "node:assert/strict";
import test from "node:test";

import {
  FinalAnswerStream,
  stripFinalAnswerProtocolTags,
} from "@/agent/runtime/FinalAnswerStream";

test("FinalAnswerStream only emits text inside final_answer tags", () => {
  const stream = new FinalAnswerStream();

  assert.deepEqual(stream.push("I will inspect first."), {
    answerClosed: false,
    answerStarted: false,
    answerText: "",
    hiddenText: "",
  });
  assert.deepEqual(stream.push("<final_answer>最终"), {
    answerClosed: false,
    answerStarted: true,
    answerText: "最终",
    hiddenText: "I will inspect first.",
  });
  assert.deepEqual(stream.push("回答</final_answer>ignored"), {
    answerClosed: true,
    answerStarted: false,
    answerText: "回答ignored",
    hiddenText: "",
  });
});

test("FinalAnswerStream handles split answer tags without leaking them", () => {
  const stream = new FinalAnswerStream();

  assert.equal(stream.push("<final_ans").answerText, "");
  const started = stream.push("wer>hello</final_ans");
  assert.equal(started.answerStarted, true);
  assert.equal(started.answerText, "hello");
  assert.equal(stream.push("wer>").answerText, "");
  assert.deepEqual(stream.finish(), {
    answerText: "",
    fallbackAnswerText: "",
    hiddenText: "",
  });
});

test("FinalAnswerStream keeps natural text after an early close tag", () => {
  const stream = new FinalAnswerStream();

  assert.equal(
    stream.push("<final_answer>现在信息已经比较充分了，整理如下：</final_answer>").answerText,
    "现在信息已经比较充分了，整理如下：",
  );
  assert.equal(
    stream.push("\n\n1. 明天是星期日。").answerText,
    "\n\n1. 明天是星期日。",
  );
  assert.deepEqual(stream.finish(), {
    answerText: "",
    fallbackAnswerText: "",
    hiddenText: "",
  });
});

test("FinalAnswerStream does not leak an unfinished close tag at finish", () => {
  const stream = new FinalAnswerStream();

  assert.equal(stream.push("<final_answer>hello</final_").answerText, "hello");
  assert.deepEqual(stream.finish(), {
    answerText: "",
    fallbackAnswerText: "",
    hiddenText: "",
  });
});

test("FinalAnswerStream returns untagged text as fallback answer", () => {
  const stream = new FinalAnswerStream();

  stream.push("plain answer");

  assert.deepEqual(stream.finish(), {
    answerText: "",
    fallbackAnswerText: "plain answer",
    hiddenText: "",
  });
});

test("stripFinalAnswerProtocolTags removes wrapper tags case-insensitively", () => {
  assert.equal(
    stripFinalAnswerProtocolTags("<FINAL_ANSWER>ok</Final_Answer>"),
    "ok",
  );
});
