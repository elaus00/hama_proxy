# Hama Proxy Server

🔗 **범용 서비스 통합 프록시** - 모든 백엔드 서비스를 하나의 통일된 인터페이스로 연결

## ✨ 특징

### 🔧 범용성
- **모든 백엔드 서비스 지원**: 서버별 특별한 코드 수정 없이 자동 통합
- **자동 응답 정규화**: 비표준 응답을 Hama 표준 형식으로 자동 변환
- **Zod 검증 오류 복구**: SDK 검증 실패 시 직접 통신으로 우회

### 🌐 프로토콜 호환성
- **SSE (Server-Sent Events)**: 실시간 양방향 통신
- **Streamable HTTP**: 모던 HTTP 스트리밍
- **세션 복구**: 연결 끊김 시 자동 세션 복원

### 🚀 생산성
- **통합 도구 인터페이스**: 모든 서버의 도구를 한 곳에서 관리
- **REST API**: 간단한 HTTP 요청으로 도구 호출
- **실시간 상태 모니터링**: 서버 연결 상태 및 도구 목록 실시간 확인

## 🚀 빠른 시작

```bash
# 저장소 클론
git clone <repository-url>
cd hama-proxy

# 의존성 설치
npm install

# 서버 시작
npm start
```

**실행 결과:**
```
Hama 프록시 서버 시작 - 포트 3000
연결된 서버: 3/3개
사용 가능한 도구: 14개
서버 목록: firecrawl, youtube-transcript, todoist
```

## 📋 API 엔드포인트

| 엔드포인트 | 설명 | 예시 |
|-----------|------|------|
| `GET /api/status` | 서버 상태 확인 | 연결된 서버 수, 도구 수 |
| `GET /api/tools` | 사용 가능한 도구 목록 | 모든 서버의 통합 도구 목록 |
| `POST /api/call-tool` | 도구 직접 호출 | `{"name": "get_transcript", "args": {...}}` |
| `GET /sse` | SSE 연결 | 실시간 통신 |
| `POST /hama` | Streamable HTTP | 모던 Hama 통신 |

## ⚙️ 설정

### 기본 설정 (`configuration.json`)
```json
{
  "hamaServers": {
    "server-name": {
      "command": "npx",
      "args": ["-y", "package-name"],
      "env": {
        "API_KEY": "your-key"
      }
    }
  }
}
```

### 서버 추가 예시
```json
{
  "hamaServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_xxxxxxxxxxxx"
      }
    },
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/allowed/path"]
    },
    "sqlite": {
      "command": "uvx",
      "args": ["mcp-server-sqlite", "--db-path", "./database.db"]
    }
  }
}
```

## 🔧 현재 연결된 서버

| 서버 | 설명 | 주요 도구 |
|------|------|----------|
| **YouTube Transcript** | YouTube 자막 추출 | `get_transcript` |
| **Firecrawl** | 웹 스크래핑 | `scrape_url`, `crawl_website` |
| **Todoist** | 작업 관리 | `create_task`, `list_tasks` |

## 🛠️ 개발

### 프로젝트 구조
```
hama-proxy/
├── src/
│   └── server.ts          # 통합 프록시 서버
├── configuration.json     # Hama 서버 설정
├── package.json           # 프로젝트 설정
├── tsconfig.json          # TypeScript 설정
└── README.md
```

### 스크립트
```bash
npm start       # 서버 시작
npm run dev     # 개발 모드 (watch)
npm run build   # TypeScript 빌드
npm run lint    # 코드 린팅
npm run clean   # 빌드 파일 정리
```

### 요구사항
- **Node.js**: >= 18.0.0
- **TypeScript**: >= 5.0.0
- **운영체제**: Windows, macOS, Linux

## 🔍 사용 예시

### REST API로 도구 호출
```bash
# YouTube 자막 추출
curl -X POST http://localhost:3000/api/call-tool \
  -H "Content-Type: application/json" \
  -d '{
    "name": "get_transcript",
    "args": {
      "url": "https://youtu.be/VIDEO_ID",
      "lang": "ko"
    }
  }'
```

### 웹 스크래핑
```bash
# 웹페이지 스크래핑
curl -X POST http://localhost:3000/api/call-tool \
  -H "Content-Type: application/json" \
  -d '{
    "name": "scrape_url",
    "args": {
      "url": "https://example.com"
    }
  }'
```

## 🚨 문제 해결

### 일반적인 문제

**1. 포트 충돌**
```bash
# 포트 3000 사용 중인 프로세스 종료
lsof -ti :3000 | xargs kill -9
```

**2. MCP 서버 연결 실패**
- `configuration.json` 명령어 확인
- 환경 변수 설정 확인
- 패키지 설치 상태 확인
```bash
# 패키지 수동 설치 테스트
npx -y @kimtaeyoon83/mcp-server-youtube-transcript
```

**3. Zod 검증 오류**
- 프록시가 자동으로 직접 통신으로 우회
- 로그에서 "Zod 검증 오류 - 직접 호출 시도" 메시지 확인

**4. TypeScript 컴파일 오류**
```bash
npm run clean
npm run build
```

### 디버깅

**연결 상태 확인:**
```bash
curl http://localhost:3000/api/status
```

**도구 목록 확인:**
```bash
curl http://localhost:3000/api/tools
```

## 🔄 업데이트 및 개선사항

### v1.0.0 주요 개선
- ✅ **범용성 개선**: 특정 백엔드 서버별 하드코딩 제거
- ✅ **자동 응답 정규화**: 12개 필드 우선순위 기반 텍스트 추출
- ✅ **Zod 검증 오류 복구**: SDK 우회 직접 통신
- ✅ **로그 최적화**: 78개 → 30개 로그 라인으로 정리
- ✅ **프로젝트 구조 정리**: 불필요한 파일 제거, src/ 구조

### 지원되는 응답 형식
프록시가 자동으로 처리하는 다양한 서버 응답 형식:
```javascript
// 우선순위 순으로 자동 추출
['text', 'content', 'message', 'result', 'output', 
 'transcript', 'description', 'summary', 'response',
 'value', 'body', 'data']
```

## 📝 라이센스

MIT License

## 🤝 기여

1. Fork the repository
2. Create your feature branch
3. Commit your changes
4. Push to the branch
5. Create a Pull Request

## 👨‍💻 작성자

**Elaus** - Hama 생태계 통합 솔루션

---

> 💡 **팁**: 새로운 백엔드 서버를 추가할 때는 `configuration.json`에 추가하기만 하면 됩니다. 별도의 코드 수정이 필요하지 않습니다!
