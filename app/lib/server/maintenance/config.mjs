// maintenance 실행 구성 상수. 불변식: LEASE_TTL_SEC > MAX_DURATION_SEC (함수가 강제 종료돼도
// 다른 인스턴스가 lease를 즉시 뺏지 않도록 TTL이 실행 상한보다 충분히 길어야 한다).
export const MAX_DURATION_SEC = 60;   // Vercel Hobby 함수 상한(504 강제 종료)
export const LEASE_TTL_SEC = 120;     // > MAX_DURATION_SEC
export const BUDGET_MS = 60000;       // 내부 시간 예산(soft 80%에서 신규 claim 중단)
