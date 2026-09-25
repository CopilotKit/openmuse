import assert from "node:assert/strict";
import test from "node:test";
import { cleanPlainText, htmlToText, isFlatTextHtml, plainTextToHtml } from "../src/emailText.ts";

test("quoted lines become blockquotes with no > markers", () => {
  const doc = plainTextToHtml("Hello\n\n> Quoted one\n> Quoted two\n\nBye");
  assert.ok(doc.includes("<p>Hello</p>"));
  assert.ok(doc.includes("<blockquote><p>Quoted one<br>Quoted two</p></blockquote>"));
  assert.ok(!doc.includes("&gt;"));
});

test("nested quotes nest blockquotes", () => {
  const doc = plainTextToHtml("> > Deep quote");
  assert.ok(doc.includes("<blockquote><blockquote><p>Deep quote</p></blockquote></blockquote>"));
});

test("blank-line runs collapse and separators become rules", () => {
  const doc = plainTextToHtml("A\n\n\n\nB\n---\nC");
  assert.ok(!doc.includes("<p></p>"));
  assert.ok(doc.includes("<hr>"));
});

test("ticket delimiters become muted notes", () => {
  const doc = plainTextToHtml("**** Please do not write below this text ****");
  assert.ok(doc.includes('class="ticket-note"'));
  assert.ok(!doc.includes("****"));
});

test("* markers become bold/italic and URLs linkify", () => {
  const doc = plainTextToHtml("**bold** and *italic* see https://example.com/x");
  assert.ok(doc.includes("<strong>bold</strong>"));
  assert.ok(doc.includes("<em>italic</em>"));
  assert.ok(doc.includes('<a href="https://example.com/x"'));
});

test("cleanPlainText strips markers and indents quotes", () => {
  const out = cleanPlainText("> *rlindahl *\n> Hi\n\n\nBye");
  assert.ok(!out.includes(">"));
  assert.ok(!out.includes("*"));
  assert.ok(out.includes("  rlindahl"));
  assert.ok(!out.includes("\n\n\n"));
});

test("isFlatTextHtml detects naive wrapped text", () => {
  assert.equal(isFlatTextHtml("<div>&gt; quoted</div>"), true);
  assert.equal(isFlatTextHtml("<div><blockquote>q</blockquote></div>"), false);
  assert.equal(isFlatTextHtml("<div>plain</div>"), false);
});

test("htmlToText unwraps simple markup", () => {
  assert.equal(htmlToText("<div>a</div><div>&gt; b</div>"), "a\n> b\n");
});
