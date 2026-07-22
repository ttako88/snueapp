// 인증 서류 경로·형식 판정 회귀 테스트.
//
// 여기서 지키는 것은 보안 경계다. GPT 검수(P-20260721-VERIFICATION_PIPELINE_
// REVIEW_AND_AUTONOMOUS_PRIORITY_01)가 지적한 TOCTOU — 사용자가 받은 staging
// 업로드 토큰으로 검증 완료된 파일을 덮어쓰는 공격 — 을 경로 분리로 막았다.
// 그 분리가 무너지면 조용히 무너지므로 테스트로 고정한다.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildStagingPath, buildVerifiedPath,
  isOwnStagingPath, isVerifiedPath,
  sniffType, MAX_BYTES, VERIFY_BUCKET,
} from "../app/lib/server/verification/files.mjs";

const UID = "11111111-2222-3333-4444-555555555555";
const OTHER = "99999999-8888-7777-6666-555555555555";

test("staging 경로는 회원별로 분리되고 무작위다", () => {
  const a = buildStagingPath(UID);
  const b = buildStagingPath(UID);
  assert.notEqual(a, b, "무작위여야 이전 요청 경로를 추측할 수 없다");
  assert.ok(isOwnStagingPath(a, UID));
  assert.ok(!isOwnStagingPath(a, OTHER), "남의 경로로 인식되면 안 된다");
});

test("staging 소유 판정은 구분자까지 본다", () => {
  // "abc" 로만 비교하면 "abcd/..." 가 통과한다 — 실제로 흔한 실수다.
  const shortId = UID.slice(0, 35) + "0";
  const p = `staging/${UID}extra/deadbeef`;
  assert.ok(!isOwnStagingPath(p, UID));
  assert.ok(!isOwnStagingPath(`staging/${shortId}/x`, UID));
});

const TOKEN = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const TOKEN2 = "12345678-1234-1234-1234-123456789abc";

test("verified 경로는 staging 으로 오인되지 않는다 (그 반대도)", () => {
  const v = buildVerifiedPath("42", TOKEN);
  assert.ok(isVerifiedPath(v));
  assert.ok(!isOwnStagingPath(v, UID), "verified 를 staging 으로 보면 TOCTOU 가 열린다");
  const s = buildStagingPath(UID);
  assert.ok(!isVerifiedPath(s), "staging 을 정본으로 보면 미검증 파일을 심사자에게 연다");
});

test("verified 경로는 (id, 선점토큰) 으로 유일하다 — claimant 별 격리", () => {
  // 토큰을 경로에 넣어 지연된 stale 작업자의 늦은 write 가 승자의 정본을 덮지
  // 못하게 한다(GPT 020 BLOCKER 반영). 같은 (id,token)=같은 경로, 토큰 다르면 다른 경로.
  assert.equal(buildVerifiedPath("42", TOKEN), buildVerifiedPath("42", TOKEN));
  assert.notEqual(buildVerifiedPath("42", TOKEN), buildVerifiedPath("42", TOKEN2));
  assert.notEqual(buildVerifiedPath("42", TOKEN), buildVerifiedPath("43", TOKEN));
  assert.equal(buildVerifiedPath("42", TOKEN), `verified/42/${TOKEN}/document`);
});

test("경로 생성은 잘못된 식별자를 거부한다", () => {
  assert.throws(() => buildStagingPath("../../etc/passwd"));
  assert.throws(() => buildStagingPath(""));
  assert.throws(() => buildVerifiedPath("0", TOKEN));
  assert.throws(() => buildVerifiedPath("1; drop table", TOKEN));
  assert.throws(() => buildVerifiedPath("", TOKEN));
  // 토큰도 검증한다 — 경로 조작·주입 방지
  assert.throws(() => buildVerifiedPath("42", "not-a-uuid"));
  assert.throws(() => buildVerifiedPath("42", "../evil"));
  assert.throws(() => buildVerifiedPath("42", ""));
  assert.throws(() => buildVerifiedPath("42", undefined));
});

// ── magic bytes ──────────────────────────────────────────────
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBP")]);
const pdf = Buffer.from("%PDF-1.7\n");

test("허용 형식은 선두 바이트로 판정한다", () => {
  assert.equal(sniffType(jpeg).mime, "image/jpeg");
  assert.equal(sniffType(png).mime, "image/png");
  assert.equal(sniffType(webp).mime, "image/webp");
  assert.equal(sniffType(pdf).mime, "application/pdf");
});

test("확장자·Content-Type 을 위장한 파일을 거른다", () => {
  // 스크립트가 실행될 수 있는 형식은 허용 목록에 없다
  assert.equal(sniffType(Buffer.from("<svg xmlns=")), null);
  assert.equal(sniffType(Buffer.from("<!DOCTYPE html>")), null);
  assert.equal(sniffType(Buffer.from("PK\x03\x04")), null);   // zip/docx
  assert.equal(sniffType(Buffer.from("GIF89a")), null);
  assert.equal(sniffType(Buffer.from([])), null);
});

test("RIFF 컨테이너는 WEBP 표식까지 확인한다", () => {
  // RIFF 는 WAV·AVI 도 쓴다. 앞 4바이트만 보면 오디오가 이미지로 통과한다.
  const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WAVE")]);
  assert.equal(sniffType(wav), null);
});

test("정책 상수가 설계값과 일치한다", () => {
  assert.equal(MAX_BYTES, 10 * 1024 * 1024);
  assert.equal(VERIFY_BUCKET, "verification-docs");
});
