# Gate 3 v1.3 수정 입력 (GPT 최종 검수 + 사용자 탈퇴 정책) — 미반영, 재개 시 이 파일대로 작업

> 상태: GATE3_DESIGN.md는 v1.2까지 반영됨. 아래 13개 정오표 + 탈퇴 콘텐츠 정책을 v1.3으로 반영해야 함.
> GPT 판정: 정책·30개 보안 지적·아키텍처 방향 = 통과 / 실행경계 정합성 = 정오표 필요 / 최종 승인 = 보류.
> 반영 후 제출 형식: A(13항목 수용표) B(수정 문장·섹션) C(사용자 결정: 탈퇴 정책은 이미 결정됨·보존기간 유보 방침) D(차단 해소표: service_role 식별/업로드 finalize/preview 접근검증/block id 유일성/hold 파기/테스트 시점) E(무변경 확인).
> 정지 조건 유지: v1.3 제출 후에도 Gate 4a·SQL·Storage·Cron·env·service_role 실사용 금지. (커밋은 사용자 지시로 v1.2+본 TODO를 체크포인트 커밋함)

## GPT 최종 정오표 13개

1. **service_role 함수와 auth.uid() 규칙 모순**: §2 원칙을 이원화 — (A) authenticated RPC: 행위자=auth.uid()만, member_id 인자 금지. (B) service_role 전용 함수: Next 서버가 사용자 토큰 검증 후 **검증된 세션 subject를 p_member_id로 전달**(요청 본문 user_id 불신), EXECUTE는 service_role만, 함수 내부에서 p_member_id의 존재·상태 재검증. 서버 인증 절차 명시(사용자용/서비스용 클라이언트 분리, 로그에 토큰·신원 금지). register_verification·계정삭제 등 일관 적용.
2. **인증 제출 2단계 분리**: 현 설계는 signed URL만 받고 업로드 안 해도 submitted가 되어 7일 시계 정지(30일 연장 우회 가능). → 1단계 begin_verification: request=uploading, member 상태 불변, 시계 계속. 2단계 finalize: 서버가 Storage object 존재+bucket/path/소유/크기/magic bytes 재검증 → 성공 시 한 트랜잭션으로 submitted 전이+시계 정지. uploading 24h 경과=upload_expired+고아 정리. 동시 제한: uploading+submitted 합산 1건. finalize↔계정삭제·withdraw 경합은 member 행 잠금. status 확정: uploading/submitted/approved/rejected/withdrawn/upload_expired/expired_unreviewed. 불변조건 "파일 검증 전에는 submitted 아님".
3. **private 스키마 자체 권한 + guest_ip_daily 누락**: private schema의 USAGE·CREATE를 PUBLIC/anon/authenticated에 미부여, service_role·pg_cron 역할 권한 명시, default privileges를 private에도 적용. **guest_ip_daily를 §1 목록·접근표·마이그레이션·RLS/REVOKE·TTL·인덱스 전부에 추가** (claim_guest_read와 TTL 배치만 접근).
4. **boards RLS 역할별 분리**: 단일 OR 정책에서 anon이 is_active_member() 실행권한 문제를 만나지 않게 — anon 정책(TO anon, USING access='preview', 함수 호출 없음) / authenticated 정책(preview 허용+members는 is_active_member()) 분리. hidden은 owner 전용 RPC만. anon에 함수 EXECUTE 부여로 해결하지 말 것.
5. **claim_guest_read 콘텐츠 접근조건 검증**: service_role은 RLS 우회이므로 함수가 직접 확인 — post 존재·deleted_at null·hidden_at null·board access='preview'·최신 댓글도 삭제/숨김 아님·응답 allowlist(내부 id/owners/HMAC/실명 금지). **권장: quota claim+안전한 preview payload 반환을 한 함수·한 트랜잭션으로**(Route가 service_role로 posts 자유 조회 금지). read_date는 서버/DB가 Asia/Seoul 기준 결정(클라이언트 불신), CAP 허용범위 검증, claim 실패 시 view_count 불변, 숨김 경합에도 숨김 콘텐츠 미반환.
6. **blocks.id 유일성**: 권장 — id uuid PRIMARY KEY + unique(blocker_id, blocked_id) + check(blocker≠blocked). opaque id가 nullable/중복 불가함을 DDL로 보장.
7. **moderate_content 대상 상한을 호출자별로**: moderator→member / operator→member·moderator / owner→member·moderator·operator. owner 작성 콘텐츠 자동 조치 금지(별도 owner/break-glass). self-target 금지. apply_sanction 동일 서열. admin_reveal_author도 동일 상한(operator는 owner 작성자 조회 불가, owner 작성자는 다른 owner/break-glass). **1인 owner 환경에서 본인 작성물 독립 심사 불가 한계 문서화**.
8. **hold 만료 = 식별값 파기**: release_expired_holds가 released_at만 남기고 HMAC 보관하면 보존기간 목적 미달 → **purge_expired_holds()로 개명, 만료 행 hard delete**, 비식별 집계 로그만.
9. **파기 시각 CHECK 수정**: "purged_at ≥ purge_after" CHECK는 즉시 파기(철회/계정삭제/고아/장기미처리)와 충돌 → purge_after를 큐 진입 시 실제 파기 가능 시각으로 설정(승인·반려=검토+7d, 철회·계정삭제·장기미처리=now(), 고아=생성+24h). CHECK는 purged_at≥purge_started_at, purged_at 존재→storage_path null 등 구조만. 고아 객체는 request CHECK가 아닌 작업 규칙으로.
10. **Gate 4a 테스트 시점 표현**: "진입 전 테스트"는 불가능(테이블이 4a에서 생김) → Gate 3 완료=명세 확정, 4a 초반=dev 적용, 중반=dev 전 항목 실행, 운영 초기화 직전=통과 보고, 4a 완료=dev 통과+운영 적용+운영 smoke.
11. **탈퇴 시 콘텐츠 정책** → 사용자가 결정함 (아래 별도 절).
12. **사건·감사 보존기간도 Gate 7 차단조건**: enforcement_holds 외에 reports.detail/case_snapshots/moderation_actions.target/audit_logs/member_status_history.actor/operational_messages/soft-deleted 콘텐츠 각각의 보존 목적·시작점·기간·사건 중 예외·파기 방식·고지·법적 검토를 출시 전 확정 목록으로 §12에 추가.
13. **정합성 정리**: get_my_verification_requests "6필드"→7필드로 수정 / guest_ip_daily 전 목록 반영(=3) / blocks.id PK(=6) / private schema 권한(=3) / is_blocked_author에 content_type 구분 시그니처 / register_verification→begin/finalize로 분리 명명(=2) / §2 예외규칙(=1).

## 사용자 최종 결정 — 탈퇴자 콘텐츠 정책 (tombstone 철회, 유지형 확정)

- **탈퇴해도 본인이 삭제하지 않은 글·댓글은 내용 유지** (정보 축적 우선). 작성자 표시만 "탈퇴한 사용자"로.
- 유지: title/body/created_at/댓글 관계/추천·조회·댓글 수/목록·검색·미리보기 노출/타인의 댓글·추천·신고·북마크 계속 가능.
- 제거: nickname(null), member_id·Auth UUID·이메일·실명·HMAC·OAuth·글 간 연결 식별자 일체. owners·anon_aliases 연결 제거. **"탈퇴한 사용자 1,2" 같은 연결 식별자 금지** — 전부 동일한 "탈퇴한 사용자".
- 데이터 모델: `author_withdrawn_at` 컬럼 신설 (deleted_at=삭제, hidden_at=운영 숨김과 3상태 구분). withdrawn만 있으면 정상 노출+표시 대체. 원 nickname 반환 금지.
- 탈퇴 전 본인이 삭제한 것: deleted_at 유지, 부활 금지, 30일 hard delete(사건 예외). hidden도 유지.
- 탈퇴 UX: 사전 고지 문구("콘텐츠 유지·연결 제거·남기기 싫으면 탈퇴 전 직접 삭제") + 내 글/댓글 확인·개별 삭제·정책 확인 체크박스·최종 확인. 약관·처리방침 명시+법률 검토 대상.
- 계정 삭제 파이프라인 최종 순서(14단계): deleting 전이→열린 사건·제재 확인→hold 생성→snapshot 생성→직접삭제/공개 콘텐츠 구분→공개분 author_nickname 제거+author_withdrawn_at 기록→owners·aliases 연결 제거→(삭제분은 기존 정책)→Storage API 삭제→성공 확인 후 메타 정리→Auth Admin 삭제→cascade 확인→비식별 로그. **연결 제거 실패 시 Auth 삭제 진행 금지, 해당 단계부터 재시도**.
- 위반 콘텐츠는 탈퇴로 부활하지 않음(hidden/deleted 유지). 탈퇴자 글 속 개인정보는 신고·삭제요청 경로로 처리.
- Gate 4a 테스트 13종 추가 (내용 유지/표시 변경/식별자 미노출/연결 제거/부활 금지/미리보기 표시/hold·snapshot 선행/실패 시 중단·재시도/멱등).

## 재개 절차 (사용자가 "ㄱㄱ" 입력 시)

1. 이 파일대로 GATE3_DESIGN.md를 v1.3으로 수정 (13항목+탈퇴 정책 통합 — §2 이원화, §4.1 begin/finalize, §4.4 전이표에 탈퇴 반영, §5.2에 author_withdrawn_at, §5.3 blocks DDL, §6 상한 매트릭스, §8 claim 통합함수, §9 함수명·파이프라인 14단계, §10 CHECK·테스트 시점·테스트 추가, §12 보존정책 목록)
2. A~E 형식 회신문 작성 → 클립보드(UTF-8 PowerShell Set-Clipboard) → GPT 재검수
3. 승인 시: GATE3_DESIGN.md 커밋 → Gate 4a 착수 계획(dev 리허설 순서표) 제시
