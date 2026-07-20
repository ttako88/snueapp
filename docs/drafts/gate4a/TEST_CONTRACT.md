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
- [T-F-06] todo — anon이 is_active_member() 등 헬퍼 직접 EXECUTE 불가 (boards anon 정책은 함수 무호출)

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
- [T-G-06] todo — retention_until 미확정 상태에서 production hold 생성 거부 (dev 플래그로 시뮬레이션)

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
