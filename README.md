# 포카 교환기

같은 현장 코드로 입장해서 포카를 올리고, 서로 원하는 포카를 매칭하는 모바일 웹입니다. Supabase 프로젝트를 연결하기 전에는 사진 추가·이름 수정만 기기에 저장되며, 가상의 교환 상대를 표시하지 않습니다.

## 로컬 실행

Node.js 22 이상, pnpm을 사용합니다.

```sh
pnpm install
pnpm dev
```

표시되는 localhost 주소로 접속하세요. HTML 파일을 직접 열거나 소스를 그대로 GitHub Pages에 올리는 방식은 지원하지 않습니다. `pnpm build`로 만들어진 `dist` 폴더가 정적 배포 결과물입니다.

## 배포

사이트 주소: https://cjy00852.github.io/poca_swap/

`main`에 푸시하면 GitHub Actions가 데이터베이스 테스트와 Vite 빌드 후 GitHub Pages에 배포합니다. 저장소 Settings → Pages의 Source는 **GitHub Actions**를 사용합니다. `.env.production`에는 브라우저 공개용 URL과 publishable 키만 포함되어 있습니다. `.env.local`과 테스트 데이터는 커밋하지 않습니다.

## Supabase 처음 연결하기

현재 로컬 작업본은 `poca-swap` 프로젝트(서울 리전)에 연결되어 있습니다. `.env.local`은 Git에서 제외됩니다. 데이터베이스 스키마와 비공개 사진 저장소, 익명 로그인을 적용했고 실제 Supabase에서 두 사용자 간 Realtime 알림·사진 접근 제어·매칭·거래 완료·현장 나가기를 검증했습니다. 검증용 사용자는 현장에서 나간 상태입니다. 아래 절차는 새 프로젝트를 연결할 때 참고하세요. 이미 연결된 프로젝트에 스키마를 다시 실행하지 마세요.

1. [Supabase 대시보드](https://supabase.com/dashboard)에서 프로젝트를 만듭니다.
2. Authentication 설정에서 **Anonymous Sign-Ins**를 켭니다. 사용자는 별도 회원가입 없이 각자의 세션을 갖습니다.
3. SQL Editor에서 `supabase/schema.sql` 전체를 **새 프로젝트에 한 번** 실행합니다. 테이블, 거래 처리 함수, RLS, 실시간 알림 테이블, 비공개 사진 저장소가 생성됩니다. 재실행용 마이그레이션이 아니므로 같은 프로젝트에 반복 실행하지 마세요.
4. 프로젝트의 URL과 **publishable key**를 확인합니다. 기존 프로젝트의 공개 `anon` 키도 사용할 수 있습니다. `service_role`, secret 키, 데이터베이스 비밀번호를 프런트엔드에 넣지 마세요.
5. `.env.example`을 `.env.local`로 복사하고 두 값을 입력합니다.

```dotenv
VITE_SUPABASE_URL=https://프로젝트ID.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=공개용키
```

6. 개발 서버를 다시 실행합니다. 서로 다른 브라우저나 시크릿 창에서 같은 현장 코드를 입력해 확인하세요.
7. 배포할 때도 같은 환경 변수를 설정한 후 `pnpm build`로 빌드합니다. 휴대폰 현장 사용은 HTTPS 주소를 사용하세요.

공개 키는 앱에 포함되도록 설계된 값입니다. 데이터 접근 권한은 로그인 세션과 데이터베이스 RLS/RPC로 제한합니다. 사진은 비공개 버킷에 저장하고 접근 권한이 있는 사용자에게만 만료되는 URL을 발급합니다.

참고: [익명 로그인](https://supabase.com/docs/guides/auth/auth-anonymous), [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security), [실시간 변경 구독](https://supabase.com/docs/guides/realtime/postgres-changes), [사진 접근 제어](https://supabase.com/docs/guides/storage/security/access-control).

## 이용 흐름

- 사진 선택 또는 휴대폰 사진 선택기의 촬영 기능으로 포카를 추가합니다. 최대 20MB 원본을 읽어 긴 변 900px의 JPEG로 줄입니다. 브라우저가 HEIC를 읽지 못하면 JPG·PNG·WebP를 안내합니다.
- `이름 · 사진 수정`에서 `뱃지 원이`, `MD원이`처럼 바꿀 수 있습니다. 같은 포카는 양쪽에서 같은 이름을 사용해야 합니다. 띄어쓰기와 영문 대소문자 차이는 무시합니다.
- 내놓아요·구해요를 선택하고 `현장에 올리기`를 눌러 공개합니다. 각 목록은 30장까지이며, 추가한 사진은 선택한 목록에 자동 선택됩니다.
- 같은 현장의 다른 사용자가 서로 반대되는 포카를 올리면 매칭됩니다. Realtime으로 새 목록을 가져오며, 연결 누락에 대비해 화면이 활성화되어 있는 동안 15초 간격으로도 새로 가져옵니다.
- `여기 있어요`는 저장된 닉네임을 노란색 전체 화면에 크게 표시합니다.
- 교환 후 한 사람이 완료를 요청하고 상대가 확인하면, 한 DB 트랜잭션에서 양쪽의 교환한 포카와 해당 구해요 항목을 제거하고 거래 내역을 기록합니다. 내놓은 포카는 내 선택 목록에서도 사라집니다.
- `현장 나가기`를 누르면 내 게시 목록과 진행 중인 완료 요청이 철회됩니다. 완료 내역과 기기에 저장한 사진은 남습니다. 창을 닫는 동작만으로는 현장에서 나가지 않습니다.

## 저장 범위와 현재 한계

익명 로그인이므로 **같은 브라우저의 로그인 정보를 유지해야 거래 내역을 다시 볼 수 있습니다**. 브라우저 데이터를 지우거나 다른 기기를 쓰면 기존 익명 계정을 복구할 수 없습니다. 장기 운영에 계정 복구가 필요하면 이메일 등 영구 로그인 연결을 추가해야 합니다.

사진 초안은 기기의 localStorage, 현장 게시물·거래 내역은 Supabase에 저장됩니다. 현장 코드를 아는 사용자는 해당 현장에 들어올 수 있으며 위치 인증은 하지 않습니다. 업로드한 사진 원본 객체는 나가기로 삭제하지 않습니다. 거래 내역의 사진을 유지하기 위해서이며, 나가기는 게시 목록 철회를 뜻합니다. 서비스 운영 시 익명 계정·미사용 사진 정리와 Supabase의 익명 가입 남용 방지 설정을 적용해야 합니다.

## 검증

```sh
pnpm test
pnpm build
# pnpm dev가 실행 중이고 Chrome이 설치된 상태에서:
pnpm test:browser
```

- DB 테스트는 PGlite(PostgreSQL)에서 실제 스키마 SQL과 RLS/RPC를 실행합니다. 현장 분리, 당사자 권한, 완료 후 양쪽 목록 제거, 중복 완료 거절, 변경·나가기 시 대기 요청 취소, 내역 유지, 사진 업로드 권한을 검사합니다.
- 브라우저 테스트는 독립된 Chrome 세션 두 개에서 실제 Supabase 클라이언트를 사용하되 Auth/REST 응답을 로컬 PostgreSQL로 대체합니다. 입장 → 매칭 → 상호 완료 → 거래 내역 → 나가기를 검증합니다.
- 실제 Supabase 프로젝트의 Auth·Storage·Realtime 통합은 프로젝트 생성 및 키 연결 후 최종 검증해야 합니다. 로컬 테스트는 실제 Supabase 서비스 검증을 대신하지 않습니다.
