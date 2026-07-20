# Gate 4a 테스트 계약 (§10 불변조건 → 테스트 케이스)

> DRAFT — 전 항목 상태 `todo`. 구현 전이므로 어떤 항목도 통과로 집계하지 않는다.
> 실행 환경: dev 프로젝트 한정, 합성 fixture만 (실제 학번·학생증·실명 금지).
> 표기: [T-그룹-번호] 상태(todo/skip/pass/fail)

## F. 함수 권한 (GATE3 §2·§10)
- [T-F-01] todo — anon으로 모든 관리·내부 함수 호출 → 전부 실패
- [T-F-02] todo — 일반 member로 관리 함수(moderate_content, apply_sanction, admin_reveal_author, grant_role) 호출 → 실패
- [T-F-03] todo — 역할별 허용 함수만 성공 (matrix 스팟체크: moderator/operator/owner 각 1)
- [T-F-04] todo — information_schema 검사: PUBLIC EXECUTE 잔존 0개
- [T-F-05] todo — 전 definer 함수 proconfig에 search_path='' 확인
- [T-F-06] todo — anon이 authz 헬퍼 직접 EXECUTE 불가 (boards anon 정책은 함수 무호출)
- [T-F-07] todo — (r2) authz 스키마가 PostgREST에 미노출 — authenticated의 REST RPC로 is_blocked_author 호출 불가 (동일 작성자 오라클 차단)
- [T-F-08] todo — (r2) 트랙 B public 래퍼 전부 EXECUTE=service_role만, authenticated 호출 실패
- [T-F-09] todo — (r3) 클라이언트가 posts의 hidden_at·author_withdrawn_at·카운터 UPDATE 시 컬럼 권한 거부. definer의 hidden_at 변경은 트리거 미발동으로 성공
- [T-F-10] todo — (r3) deleted_at: 임의 시각 지정해도 now()로 강제, 복구(재-null) 불가, 삭제 후 수정 불가

## M. members (§3)
- [T-M-01] todo — authenticated로 private.members 직접 select/insert/update → 실패 (스키마 USAGE부터 차단)
- [T-M-02] todo — auth 가입 시 members 행 자동 생성 (nickname null, pending, deadline=+7d)
- [T-M-03] todo — set_initial_nickname 정상/금칙어/중복(대소문자 변형 포함) 거부
- [T-M-04] todo — 온보딩 미완료(nickname null) 계정의 is_active_member()=false
- [T-M-05] todo — change_nickname 30일 규칙·nickname_changed_at 기록
- [T-M-06] todo — get_my_member()는 본인 행만, 반환 컬럼 고정

## R. 콘텐츠 RLS (§5)
- [T-R-01] todo — 미인증(pending)·submitted 계정: posts select 실패
- [T-R-02] todo — community_suspended·banned: select 실패 / write_restricted: select 성공+insert·vote 실패
- [T-R-03] todo — hidden 게시판 글 차단, members 게시판은 비활성 회원 차단
- [T-R-04] todo — deleted_at·hidden_at 글·댓글 미반환
- [T-R-05] todo — 타인 글 update 실패, 본인 글 update 성공, board_id·카운터·created_at 변경 거부(트리거)
- [T-R-06] todo — posts DELETE 정책 없음 → hard delete 실패
- [T-R-07] todo — 댓글: 부모 post 열람 불가 조건에서 select/insert 실패
- [T-R-08] todo — 차단한 작성자 콘텐츠: 직접 select에서도 제외 (RLS 집행 확인)

## V. 신원·2단계 제출 (§4 — v1.3)
- [T-V-01] todo — get_my_verification_requests 반환 7필드 고정, hmac·path·reviewer 미노출
- [T-V-02] todo — begin만 하고 업로드 없음 → member 불변·삭제 시계 계속
- [T-V-03] todo — 빈 객체/타인 경로/10MB 초과/위조 magic bytes → finalize 실패, submitted 미전이
- [T-V-04] todo — 정상 finalize → 한 트랜잭션으로 submitted 전이+시계 정지
- [T-V-05] todo — uploading 24h 경과 배치 → upload_expired+객체 정리
- [T-V-06] todo — uploading+submitted 합산 1건 unique 강제
- [T-V-07] todo — 전 키버전 HMAC 중복 차단·hold 대조 차단 ("인증할 수 없는 학번" 응답 동일성)
- [T-V-08] todo — 동시 승인 경쟁 → unique(hmac_key_version, student_no_hmac)가 차단
- [T-V-09] todo — finalize ↔ 계정삭제 경합: member 행 잠금으로 직렬화
- [T-V-10] todo — 로그·응답에 학번 원문/HMAC 부재 (서버 로그 검사)

## D. 모더레이션 (§5.5·§6)
- [T-D-01] todo — moderator 응답에 대상 member id 미포함
- [T-D-02] todo — 대상 상한 매트릭스: moderator→moderator 조치 실패, operator→operator 실패, owner→owner 실패(자동 조치 전면 금지)
- [T-D-03] todo — self-target 전부 거부
- [T-D-04] todo — admin_reveal_author: 무관 case_id 차용 실패, reason 검증, audit 동일 트랜잭션
- [T-D-05] todo — 신고자 정보 moderator 화면 projection 미노출, 신고자 탈퇴 시 reporter null화+사건 보존
- [T-D-06] todo — 동시 신고 → 단일 open 사건 수렴, resolved 다건 허용
- [T-D-07] todo — (r2) 탈퇴자 콘텐츠 hide/restore 가능, warn·write_restrict는 일반 거부
- [T-D-08] todo — (r2) 해제 대칭: moderator가 suspend 해제 실패, banned 해제는 owner만
- [T-D-09] todo — (r2) write_restrict는 spam reason_code 사건에서만 성공
- [T-D-10] todo — (r2) 동시 grant_role 강등 경쟁 → owner 0명 불가 (advisory lock)
- [T-D-11] todo — (r2) submit_report: 미인증·suspended 실패, write_restricted 성공, 반복 호출로 report_count 미증가

## A. 익명·차단 (§5.3·§5.4)
- [T-A-01] todo — block_author: 신규/중복 동일 응답, 자기 차단 거부
- [T-A-02] todo — list_my_blocks: opaque id·시각만
- [T-A-03] todo — 동시 첫 익명 댓글 → 별칭 번호 충돌 없음 (부모 행 잠금)

## P. 비회원 미리보기 — 함수 수준 (§8. Route는 Gate 5)
- [T-P-01] todo — claim_guest_read: 동시 4요청 중 3글만 통과
- [T-P-02] todo — 재열람 무차감·view_count 1회
- [T-P-03] todo — 4글째: quota 미차감·본문 미반환·view_count 불변
- [T-P-04] todo — 삭제·숨김·members 게시판 글 → 거부(미차감), 응답 allowlist 준수
- [T-P-05] todo — read_date 함수 내부 KST 결정, 날짜 전환 시 초기화
- [T-P-06] todo — IP 캡 도달 → 거부, 쿠키/IP 제한 구분 비노출

## G. 파기·hold (§4.4·§9)
- [T-G-01] todo — Storage API 삭제 성공 후에만 path·real_name null (실패 시 유지+attempts 기록)
- [T-G-02] todo — 철회·고아·30일 soft delete 정리 각 1건
- [T-G-03] todo — 계정 삭제 시 hold가 cascade보다 선행
- [T-G-04] todo — purge_expired_holds: retention_until 경과 행 hard delete 확인
- [T-G-05] todo — 삭제된 계정의 잔존 JWT로 접근 차단
- [T-G-06] todo — (r2) policy_settings.hold_retention_days null → hold 필요 탈퇴 거부, 값 설정 시 retention_until 자동 계산 (dev는 트랜잭션 내 fixture 값+롤백)
- [T-G-07] todo — (r2) 30일 정리: 하위 댓글 포함 트리째 삭제, 글·하위 댓글 어느 쪽이든 열린 사건 있으면 전체 보존
- [T-G-08] todo — (r2) 배치 실패 시 본문 롤백+batch_runs 실패 기록 보존, 3연속 실패 owner 메시지

## X. maintenance Route·서버 작업 (r4 — GPT 3차)
- [T-X-01] todo — GET+정상 Bearer만 실행. POST는 405
- [T-X-02] todo — MAINTENANCE_ENABLED 미설정/false → 인증 무관 무작업 disabled
- [T-X-03] todo — 잘못된 secret·16자 미만 secret·잘못된 project ref·미등록 job → 전부 무작업
- [T-X-04] todo — 동일 job 동시 2회 호출 중 1회만 lease 획득, 나머지는 already_running
- [T-X-05] todo — lease 만료(leased_until 경과) 후 다음 실행이 회수
- [T-X-06] todo — upload_expired 전이 후 Storage 삭제 실패 → 다음 실행이 재선별·정리
- [T-X-07] todo — 3/7일 owner 경고 중복 발송 없음 (owner_warned_*_at 컬럼 대조)
- [T-X-08] todo — signed upload는 성공하면서 anon/authenticated의 storage.objects 직접 접근은 실패
- [T-X-09] todo — Vercel 중복 호출 시나리오에서 계정 삭제·파기 결과 동일 (멱등)
- [T-X-10] todo — provision-storage: config 불일치 시 변경 없이 실패, dry-run도 ref 검증 선행

## W. 탈퇴 콘텐츠 13종 (§13 — v1.3)
- [T-W-01] todo — 비삭제 글·댓글 내용 유지
- [T-W-02] todo — 작성자 표시 전원 동일 "탈퇴한 사용자"
- [T-W-03] todo — 응답에 원 닉네임·member_id·UUID 등 식별자 0건
- [T-W-04] todo — owners·anon_aliases 연결 행 삭제
- [T-W-05] todo — 탈퇴 전 본인 삭제분 부활 없음
- [T-W-06] todo — hidden 유지
- [T-W-07] todo — claim_guest_read 응답에서도 "탈퇴한 사용자"
- [T-W-08] todo — hold·snapshot이 cascade 선행
- [T-W-09] todo — 연결 제거 실패 시 Auth 삭제 미진행
- [T-W-10] todo — 실패 단계부터 재시도 멱등
- [T-W-11] todo — 타인의 댓글·추천·신고·북마크 계속 동작
- [T-W-12] todo — 본인 삭제분 30일 hard delete 정책 유지
- [T-W-13] todo — 탈퇴 글 간 연결 추론 식별자 부재
