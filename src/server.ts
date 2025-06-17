// Hama Proxy Server - Multiple backend servers integration proxy
import express from 'express';
import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs';
import { randomUUID } from 'node:crypto';

// @modelcontextprotocol/sdk 패키지에서 import
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport, EventStore } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { 
    LoggingMessageNotificationSchema, 
    ResourceListChangedNotificationSchema,
    isInitializeRequest,
    JSONRPCMessage,
    ServerCapabilities
} from "@modelcontextprotocol/sdk/types.js";

/**
 * In-Memory Event Store
 */
class InMemoryEventStore implements EventStore {
    private events: Map<string, { message: JSONRPCMessage; streamId: string }> = new Map();

    async replayEventsAfter(
        lastEventId: string,
        { send }: { send: (eventId: string, message: JSONRPCMessage) => Promise<void> }
    ): Promise<string> {
        if (!lastEventId || !this.events.has(lastEventId)) {
            return "";
        }

        const streamId = this.getStreamIdFromEventId(lastEventId);
        if (!streamId) {
            return "";
        }

        let foundLastEvent = false;
        const sortedEvents = [...this.events.entries()].sort((a, b) => a[0].localeCompare(b[0]));

        for (const [eventId, { message, streamId: eventStreamId }] of sortedEvents) {
            if (eventStreamId !== streamId) {
                continue;
            }

            if (eventId === lastEventId) {
                foundLastEvent = true;
                continue;
            }

            if (foundLastEvent) {
                await send(eventId, message);
            }
        }
        
        return streamId;
    }

    async storeEvent(streamId: string, message: JSONRPCMessage): Promise<string> {
        const eventId = this.generateEventId(streamId);
        this.events.set(eventId, { message, streamId });
        return eventId;
    }

    private generateEventId(streamId: string): string {
        return `${streamId}_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
    }

    private getStreamIdFromEventId(eventId: string): string {
        const parts = eventId.split("_");
        return parts.length > 0 ? parts[0] : "";
    }
}

/**
 * Hama 서버 구성 파일 인터페이스
 */
interface HamaServerConfig {
    hamaServers: {
        [key: string]: {
            command: string;
            args: string[];
            env?: { [key: string]: string };
        }
    }
}

/**
 * 통합된 Hama 클라이언트 연결 정보
 */
interface HamaClientConnection {
    serverName: string;
    client: Client;
    transport: StdioClientTransport;
    active: boolean;
    tools: any[];
    prompts: any[];
    resources: any[];
}

/**
 * 프록시 서버 설정 (개선된 스타일)
 */
const setupProxyServer = async (
    client: Client,
    server: Server,
    serverCapabilities: ServerCapabilities
): Promise<void> => {
    // Logging 지원
    if (serverCapabilities?.logging) {
        server.setNotificationHandler(LoggingMessageNotificationSchema, async (args) => {
            return client.notification(args);
        });
        client.setNotificationHandler(LoggingMessageNotificationSchema, async (args) => {
            return server.notification(args);
        });
    }

    // Tools 지원
    if (serverCapabilities?.tools) {
        server.setRequestHandler({ method: "tools/call" }, async (args) => {
            return client.callTool(args.params);
        });
        server.setRequestHandler({ method: "tools/list" }, async (args) => {
            return client.listTools(args.params);
        });
    }

    // Prompts 지원
    if (serverCapabilities?.prompts) {
        server.setRequestHandler({ method: "prompts/get" }, async (args) => {
            return client.getPrompt(args.params);
        });
        server.setRequestHandler({ method: "prompts/list" }, async (args) => {
            return client.listPrompts(args.params);
        });
    }

    // Resources 지원
    if (serverCapabilities?.resources) {
        server.setRequestHandler({ method: "resources/list" }, async (args) => {
            return client.listResources(args.params);
        });
        server.setRequestHandler({ method: "resources/read" }, async (args) => {
            return client.readResource(args.params);
        });

        if (serverCapabilities?.resources.subscribe) {
            server.setNotificationHandler(ResourceListChangedNotificationSchema, async (args) => {
                return client.notification(args);
            });
            server.setRequestHandler({ method: "resources/subscribe" }, async (args) => {
                return client.subscribeResource(args.params);
            });
            server.setRequestHandler({ method: "resources/unsubscribe" }, async (args) => {
                return client.unsubscribeResource(args.params);
            });
        }
    }

    // Completion 지원
    server.setRequestHandler({ method: "completion/complete" }, async (args) => {
        return client.complete(args.params);
    });
};

/**
 * 요청 본문 파싱 헬퍼 (개선된 버전)
 */
const getBody = (request: http.IncomingMessage): Promise<any> => {
    return new Promise((resolve) => {
        const bodyParts: Buffer[] = [];
        let body: string;
        request
            .on("data", (chunk) => {
                bodyParts.push(chunk);
            })
            .on("end", () => {
                body = Buffer.concat(bodyParts).toString();
                try {
                    resolve(JSON.parse(body));
                } catch(error) {
                    console.error("[hama-proxy] error parsing body", error);
                    resolve(null);
                }
            });
    });
};

/**
 * 개선된 통합 Hama 서버 관리자
 */
class EnhancedHamaManager {
    private configPath: string;
    private config: HamaServerConfig | null = null;
    private hamaConnections: Map<string, HamaClientConnection> = new Map();
    private eventStore: EventStore = new InMemoryEventStore();

    // SSE 및 Stream 전송 관리
    private activeSSETransports: Map<string, SSEServerTransport> = new Map();
    private activeStreamTransports: Map<string, {
        server: Server;
        transport: StreamableHTTPServerTransport;
    }> = new Map();

    constructor(configPath?: string) {
        this.configPath = configPath || path.join(process.cwd(), 'configuration.json');
        this.loadConfig();
    }

    /**
     * 구성 파일 로드
     */
    loadConfig(): HamaServerConfig {
        try {
            console.log(`🔧 Hama 서버 구성 파일 로드: ${this.configPath}`);

            if (!fs.existsSync(this.configPath)) {
                throw new Error(`구성 파일을 찾을 수 없습니다: ${this.configPath}`);
            }

            const configContent = fs.readFileSync(this.configPath, 'utf-8');
            this.config = JSON.parse(configContent) as HamaServerConfig;

            if (!this.config?.hamaServers || Object.keys(this.config.hamaServers).length === 0) {
                throw new Error('구성 파일에 Hama 서버 정보가 없습니다');
            }

            console.log(`✅ 로드된 Hama 서버들: ${Object.keys(this.config.hamaServers).join(', ')}`);
            return this.config;
        } catch (error) {
            console.error(`❌ Hama 서버 구성 로드 중 오류: ${error}`);
            throw error;
        }
    }

    /**
     * 모든 Hama 서버에 자동 연결
     */
    async connectAllServers(): Promise<void> {
        if (!this.config) {
            throw new Error('구성이 로드되지 않았습니다');
        }

        console.log('🚀 모든 Hama 서버에 연결 시작...');

        const connectionPromises = Object.entries(this.config.hamaServers).map(
            async ([serverName, serverConfig]) => {
                try {
                    await this.connectToServer(serverName, serverConfig);
                    console.log(`✅ ${serverName} 연결 성공`);
                } catch (error) {
                    console.error(`❌ ${serverName} 연결 실패:`, error);
                }
            }
        );

        await Promise.allSettled(connectionPromises);
        console.log(`🎉 Hama 서버 연결 완료. 활성 연결: ${this.hamaConnections.size}개`);
    }

    /**
     * 개별 Hama 서버 연결
     */
    private async connectToServer(
        serverName: string, 
        serverConfig: { command: string; args: string[]; env?: { [key: string]: string } }
    ): Promise<void> {
        console.log(`🔌 ${serverName} 연결 중... (${serverConfig.command} ${serverConfig.args.join(' ')})`);

        // MCP 클라이언트 생성 (하위 호환성 유지)
        const mcpClient = new Client({
            name: 'hama-proxy-client',
            version: '1.0.0',
            capabilities: {
                tools: true,
                resources: { subscribe: true },
                prompts: true,
                completion: true,
                logging: true
            }
        });

        // Transport 생성
        const transport = new StdioClientTransport({
            command: serverConfig.command,
            args: serverConfig.args,
            stderr: 'pipe',
            env: serverConfig.env ? { ...getDefaultEnvironment(), ...serverConfig.env } : undefined
        });

        // 오류 처리
        transport.stderr?.on('data', (data) => {
            console.error(`[${serverName}] stderr:`, data.toString());
        });

        // 연결
        await mcpClient.connect(transport);

        // 초기 데이터 로드
        const [tools, prompts, resources] = await Promise.allSettled([
            mcpClient.listTools().catch(() => ({ tools: [] })),
            mcpClient.listPrompts().catch(() => ({ prompts: [] })),
            mcpClient.listResources().catch(() => ({ resources: [] }))
        ]);

        const hamaConnection: HamaClientConnection = {
            serverName,
            client: mcpClient,
            transport,
            active: true,
            tools: tools.status === 'fulfilled' ? tools.value.tools : [],
            prompts: prompts.status === 'fulfilled' ? prompts.value.prompts : [],
            resources: resources.status === 'fulfilled' ? resources.value.resources : []
        };

        // 알림 핸들러 설정
        mcpClient.setNotificationHandler(ResourceListChangedNotificationSchema, async () => {
            await this.refreshServerData(serverName);
        });

        mcpClient.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
            console.log(`[${serverName}] ${notification.params.level}:`, notification.params.data);
        });

        this.hamaConnections.set(serverName, hamaConnection);
    }

    /**
     * 서버 데이터 새로고침
     */
    private async refreshServerData(serverName: string): Promise<void> {
        const connection = this.hamaConnections.get(serverName);
        if (!connection) return;

        try {
            const [tools, prompts, resources] = await Promise.allSettled([
                connection.client.listTools().catch(() => ({ tools: [] })),
                connection.client.listPrompts().catch(() => ({ prompts: [] })),
                connection.client.listResources().catch(() => ({ resources: [] }))
            ]);

            connection.tools = tools.status === 'fulfilled' ? tools.value.tools : [];
            connection.prompts = prompts.status === 'fulfilled' ? prompts.value.prompts : [];
            connection.resources = resources.status === 'fulfilled' ? resources.value.resources : [];
        } catch (error) {
            console.error(`서버 데이터 새로고침 실패 (${serverName}):`, error);
        }
    }

    /**
     * 프록시 서버 생성 (특정 Hama 서버용)
     */
    async createProxyServer(serverName: string): Promise<Server> {
        const connection = this.hamaConnections.get(serverName);
        if (!connection || !connection.active) {
            throw new Error(`서버에 연결할 수 없습니다: ${serverName}`);
        }

        const server = new Server({
            name: `proxy-${serverName}`,
            version: '1.0.0',
            capabilities: {
                tools: true,
                resources: { subscribe: true },
                prompts: true,
                completion: true,
                logging: true
            }
        });

        // 프록시 설정
        await setupProxyServer(connection.client, server, {
            tools: true,
            resources: { subscribe: true },
            prompts: true,
            completion: true,
            logging: true
        });

        return server;
    }

    /**
     * 통합된 프록시 서버 생성 (모든 Hama 서버 통합)
     */
    async createUnifiedProxyServer(): Promise<Server> {
        const server = new Server({
            name: 'unified-hama-proxy',
            version: '1.0.0',
            capabilities: {
                tools: true,
                resources: { subscribe: true },
                prompts: true,
                completion: true,
                logging: true
            }
        });

        // 통합된 요청 처리
        server.setRequestHandler({ method: "tools/list" }, async () => {
            return { tools: this.getUnifiedTools() };
        });

        server.setRequestHandler({ method: "tools/call" }, async (args) => {
            try {
                return await this.callTool(args.params.name, args.params.arguments || {});
            } catch (error) {
                console.error(`프록시 서버 도구 호출 실패:`, error);
                throw error;
            }
        });

        server.setRequestHandler({ method: "prompts/list" }, async () => {
            return { prompts: this.getUnifiedPrompts() };
        });

        server.setRequestHandler({ method: "prompts/get" }, async (args) => {
            return this.getPrompt(args.params.name, args.params.arguments || {});
        });

        server.setRequestHandler({ method: "resources/list" }, async () => {
            return { resources: this.getUnifiedResources() };
        });

        server.setRequestHandler({ method: "resources/read" }, async (args) => {
            return this.readResource(args.params.uri);
        });

        return server;
    }

    /**
     * 통합된 도구 목록 제공
     */
    getUnifiedTools(): any[] {
        const allTools: any[] = [];
        for (const [serverName, connection] of this.hamaConnections) {
            if (connection.active) {
                connection.tools.forEach(tool => {
                    allTools.push({
                        ...tool,
                        serverName,
                        fullName: `${serverName}:${tool.name}`
                    });
                });
            }
        }
        return allTools;
    }

    /**
     * 통합된 프롬프트 목록 제공
     */
    getUnifiedPrompts(): any[] {
        const allPrompts: any[] = [];
        for (const [serverName, connection] of this.hamaConnections) {
            if (connection.active) {
                connection.prompts.forEach(prompt => {
                    allPrompts.push({
                        ...prompt,
                        serverName,
                        fullName: `${serverName}:${prompt.name}`
                    });
                });
            }
        }
        return allPrompts;
    }

    /**
     * 통합된 리소스 목록 제공
     */
    getUnifiedResources(): any[] {
        const allResources: any[] = [];
        for (const [serverName, connection] of this.hamaConnections) {
            if (connection.active) {
                connection.resources.forEach(resource => {
                    allResources.push({
                        ...resource,
                        serverName,
                        fullUri: `${serverName}:${resource.uri}`
                    });
                });
            }
        }
        return allResources;
    }

    /**
     * 도구 호출
     */
    async callTool(toolName: string, params: any): Promise<any> {
        console.log(`도구 호출: ${toolName}`);
        
        let targetServer: string;
        let actualToolName: string;

        if (toolName.includes(':')) {
            [targetServer, actualToolName] = toolName.split(':', 2);
        } else {
            const connection = Array.from(this.hamaConnections.values())
                .find(conn => conn.active && conn.tools.some(tool => tool.name === toolName));
            
            if (!connection) {
                console.error(`❌ 도구 찾기 실패: ${toolName}`);
                throw new Error(`도구를 찾을 수 없습니다: ${toolName}`);
            }
            
            targetServer = connection.serverName;
            actualToolName = toolName;
        }

        const connection = this.hamaConnections.get(targetServer);
        if (!connection || !connection.active) {
            console.error(`서버 연결 실패: ${targetServer}`);
            throw new Error(`서버에 연결할 수 없습니다: ${targetServer}`);
        }
        let result;
        try {
            result = await connection.client.callTool({
                name: actualToolName,
                arguments: params
            });
        } catch (error) {
            console.error(`❌ MCP 클라이언트 호출 실패:`, error);
            
            // Zod 스키마 검증 오류인 경우 원본 응답 데이터 추출 시도
            if (error.name === 'ZodError' && error.issues) {
                console.log(`Zod 검증 오류 - 직접 호출 시도`);
                
                try {
                    const rawResult = await this.callToolDirectly(connection, actualToolName, params);
                    result = rawResult;
                } catch (directError) {
                    console.error(`직접 호출 실패:`, directError);
                    
                    // 최후의 수단: 기본 오류 응답 생성
                    return {
                        content: [{
                            type: "text",
                            text: `도구 실행 오류: MCP 응답 형식 문제 (${actualToolName})\n오류 세부사항: ${error.message}`
                        }]
                    };
                }
            } else {
                throw error;
            }
        }

        // MCP 프로토콜 준수를 위한 응답 검증 및 강제 변환
        try {            
            // 모든 응답을 올바른 MCP 형식으로 정규화
            if (!result) {
                return {
                    content: [{ type: "text", text: "도구 실행 완료 (응답 없음)" }]
                };
            }

            // 이미 올바른 형식인지 확인
            if (result.content && Array.isArray(result.content) && result.content.length > 0) {
                return result;
            }
            
            // 응답이 문자열인 경우
            if (typeof result === 'string') {
                return {
                    content: [{ type: "text", text: result }]
                };
            }
            
            // 응답이 객체인 경우 - 다양한 패턴 시도
            if (typeof result === 'object') {
                // 텍스트 내용을 추출할 수 있는 필드들 (우선순위 순)
                const textFields = [
                    'text', 'content', 'message', 'result', 'output', 
                    'transcript', 'description', 'summary', 'response',
                    'value', 'body', 'data'
                ];
                
                let textContent = '';
                let usedField = '';
                
                // 우선순위대로 필드 확인
                for (const field of textFields) {
                    if (result[field] !== undefined && result[field] !== null) {
                        if (typeof result[field] === 'string') {
                            textContent = result[field];
                            usedField = field;
                            break;
                        } else if (typeof result[field] === 'object') {
                            textContent = JSON.stringify(result[field], null, 2);
                            usedField = field;
                            break;
                        }
                    }
                }
                
                // 적절한 필드를 찾지 못한 경우 전체 객체를 JSON으로 변환
                if (!textContent) {
                    textContent = JSON.stringify(result, null, 2);
                    usedField = 'full_object';
                }
                
                return {
                    content: [{ 
                        type: "text", 
                        text: textContent
                    }]
                };
            }

            // 기타 타입 (number, boolean 등)
            return {
                content: [{ type: "text", text: String(result) }]
            };

        } catch (error) {
            console.error(`도구 응답 변환 오류:`, error);
            return {
                content: [{ 
                    type: "text", 
                    text: `도구 실행 오류: ${(error as Error).message}` 
                }]
            };
        }
    }

    /**
     * MCP 클라이언트 우회하여 직접 도구 호출
     * Zod 검증 오류를 피하기 위한 로우레벨 접근
     */
    private async callToolDirectly(connection: any, toolName: string, params: any): Promise<any> {
        
        // MCP 클라이언트의 내부 전송 계층에 직접 접근
        const transport = (connection.client as any)._transport;
        if (!transport) {
            throw new Error('전송 계층에 접근할 수 없습니다');
        }

        // JSON-RPC 요청 생성
        const request = {
            jsonrpc: "2.0",
            id: Date.now(),
            method: "tools/call",
            params: {
                name: toolName,
                arguments: params
            }
        };


        // Promise를 사용하여 응답 대기
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('직접 호출 타임아웃'));
            }, 30000);

            // 응답 핸들러 설정
            const originalOnMessage = transport.onmessage;
            transport.onmessage = (response: any) => {
                
                if (response.id === request.id) {
                    clearTimeout(timeout);
                    transport.onmessage = originalOnMessage; // 원래 핸들러 복원
                    
                    if (response.error) {
                        reject(new Error(response.error.message || '도구 호출 오류'));
                    } else {
                        // 원본 응답을 그대로 반환 (Zod 검증 없이)
                        resolve(response.result);
                    }
                } else {
                    // 다른 응답은 원래 핸들러로 전달
                    if (originalOnMessage) {
                        originalOnMessage(response);
                    }
                }
            };

            // 요청 전송
            try {
                if (transport.send) {
                    transport.send(request);
                } else {
                    reject(new Error('전송 메서드를 사용할 수 없습니다'));
                }
            } catch (sendError) {
                clearTimeout(timeout);
                transport.onmessage = originalOnMessage;
                reject(sendError);
            }
        });
    }

    /**
     * 프롬프트 호출
     */
    async getPrompt(promptName: string, params: any): Promise<any> {
        let targetServer: string;
        let actualPromptName: string;

        if (promptName.includes(':')) {
            [targetServer, actualPromptName] = promptName.split(':', 2);
        } else {
            const connection = Array.from(this.hamaConnections.values())
                .find(conn => conn.active && conn.prompts.some(prompt => prompt.name === promptName));
            
            if (!connection) {
                throw new Error(`프롬프트를 찾을 수 없습니다: ${promptName}`);
            }
            
            targetServer = connection.serverName;
            actualPromptName = promptName;
        }

        const connection = this.hamaConnections.get(targetServer);
        if (!connection || !connection.active) {
            throw new Error(`서버에 연결할 수 없습니다: ${targetServer}`);
        }

        return await connection.client.getPrompt({
            name: actualPromptName,
            arguments: params
        });
    }

    /**
     * 리소스 읽기
     */
    async readResource(resourceUri: string): Promise<any> {
        let targetServer: string;
        let actualUri: string;

        if (resourceUri.includes(':')) {
            [targetServer, actualUri] = resourceUri.split(':', 2);
        } else {
            const connection = Array.from(this.hamaConnections.values())
                .find(conn => conn.active && conn.resources.some(resource => resource.uri === resourceUri));
            
            if (!connection) {
                throw new Error(`리소스를 찾을 수 없습니다: ${resourceUri}`);
            }
            
            targetServer = connection.serverName;
            actualUri = resourceUri;
        }

        const connection = this.hamaConnections.get(targetServer);
        if (!connection || !connection.active) {
            throw new Error(`서버에 연결할 수 없습니다: ${targetServer}`);
        }

        return await connection.client.readResource({ uri: actualUri });
    }

    /**
     * 연결 상태 정보
     */
    getConnectionStatus(): any {
        return {
            totalServers: Object.keys(this.config?.hamaServers || {}).length,
            activeConnections: this.hamaConnections.size,
            connectedServers: Array.from(this.hamaConnections.keys()),
            totalTools: this.getUnifiedTools().length,
            totalPrompts: this.getUnifiedPrompts().length,
            totalResources: this.getUnifiedResources().length,
            activeSSESessions: this.activeSSETransports.size,
            activeStreamSessions: this.activeStreamTransports.size
        };
    }

    /**
     * SSE 요청 처리 미들웨어
     */
    createSSEMiddleware() {
        return async (req: express.Request, res: express.Response, next: express.NextFunction) => {
            if (req.method === "GET" && req.path === "/sse") {
                const serverName = req.query.server as string || "unified";
                const transport = new SSEServerTransport("/messages", res as any);

                let server: Server;
                try {
                    if (serverName === "unified") {
                        server = await this.createUnifiedProxyServer();
                    } else {
                        server = await this.createProxyServer(serverName);
                    }
                } catch (error) {
                    res.status(500).end("Error creating server");
                    return;
                }

                this.activeSSETransports.set(transport.sessionId, transport);

                let closed = false;
                res.on("close", async () => {
                    closed = true;
                    try {
                        await server.close();
                    } catch (error) {
                        console.error("[hama-proxy] error closing server", error);
                    }
                    this.activeSSETransports.delete(transport.sessionId);
                });

                try {
                    await server.connect(transport);
                    await transport.send({
                        jsonrpc: "2.0",
                        method: "sse/connection",
                        params: { message: "SSE Connection established" },
                    });
                } catch (error) {
                    if (!closed) {
                        console.error("[hama-proxy] error connecting to server", error);
                        res.status(500).end("Error connecting to server");
                    }
                }
                return; // 응답 완료, next() 호출하지 않음
            }

            if (req.method === "POST" && req.path.startsWith("/messages")) {
                const sessionId = req.query.sessionId as string;
                if (!sessionId) {
                    res.status(400).end("No sessionId");
                    return;
                }

                const activeTransport = this.activeSSETransports.get(sessionId);
                if (!activeTransport) {
                    res.status(400).end("No active transport");
                    return;
                }

                await activeTransport.handlePostMessage(req as any, res as any);
                return; // 응답 완료, next() 호출하지 않음
            }

            next(); // 다음 미들웨어로 전달
        };
    }

    /**
     * Streamable HTTP 요청 처리 미들웨어
     */
    createStreamMiddleware() {
        return async (req: express.Request, res: express.Response, next: express.NextFunction) => {
            if (req.path !== "/hama") {
                next();
                return;
            }

            if (req.method === "POST") {
                try {
                    const sessionId = req.headers["mcp-session-id"] as string;
                    let transport: StreamableHTTPServerTransport;
                    let server: Server;
                    const body = req.body;

                    if (sessionId && this.activeStreamTransports.has(sessionId)) {
                        const activeTransport = this.activeStreamTransports.get(sessionId)!;
                        transport = activeTransport.transport;
                        server = activeTransport.server;
                    } else if (!sessionId && isInitializeRequest(body)) {
                        const serverName = body.params?.serverName || "unified";
                        
                        transport = new StreamableHTTPServerTransport({
                            eventStore: this.eventStore,
                            onsessioninitialized: (_sessionId) => {
                                this.activeStreamTransports.set(_sessionId, { server, transport });
                            },
                            sessionIdGenerator: randomUUID,
                        });

                        transport.onclose = async () => {
                            const sid = transport.sessionId;
                            if (sid && this.activeStreamTransports.has(sid)) {
                                try {
                                    await server.close();
                                } catch (error) {
                                    console.error("[hama-proxy] error closing server", error);
                                }
                                this.activeStreamTransports.delete(sid);
                            }
                        };

                        try {
                            if (serverName === "unified") {
                                server = await this.createUnifiedProxyServer();
                            } else {
                                server = await this.createProxyServer(serverName);
                            }
                        } catch (error) {
                            res.status(500).end("Error creating server");
                            return;
                        }

                        server.connect(transport);
                    } else {
                        res.setHeader("Content-Type", "application/json");
                        res.status(400).json({
                            error: { code: -32000, message: "Bad Request: No valid session ID provided" },
                            id: null,
                            jsonrpc: "2.0",
                        });
                        return;
                    }

                    await transport.handleRequest(req as any, res as any, body);
                    return;
                } catch (error) {
                    console.error("[hama-proxy] error handling request", error);
                    res.setHeader("Content-Type", "application/json");
                    res.status(500).json({
                        error: { code: -32603, message: "Internal Server Error" },
                        id: null,
                        jsonrpc: "2.0",
                    });
                    return;
                }
            }

            if (req.method === "GET") {
                const sessionId = req.headers["mcp-session-id"] as string;
                const activeTransport = sessionId ? this.activeStreamTransports.get(sessionId) : undefined;

                if (!sessionId) {
                    res.status(400).end("No sessionId");
                    return;
                }

                if (!activeTransport) {
                    res.status(400).end("No active transport");
                    return;
                }

                const lastEventId = req.headers["last-event-id"] as string | undefined;
                if (lastEventId) {
                    console.log(`[hama-proxy] client reconnecting with Last-Event-ID ${lastEventId} for session ID ${sessionId}`);
                } else {
                    console.log(`[hama-proxy] establishing new SSE stream for session ID ${sessionId}`);
                }

                await activeTransport.transport.handleRequest(req as any, res as any);
                return;
            }

            if (req.method === "DELETE") {
                const sessionId = req.headers["mcp-session-id"] as string;
                if (!sessionId) {
                    res.status(400).end("Invalid or missing sessionId");
                    return;
                }

                const activeTransport = this.activeStreamTransports.get(sessionId);
                if (!activeTransport) {
                    res.status(400).end("No active transport");
                    return;
                }

                try {
                    await activeTransport.transport.handleRequest(req as any, res as any);
                } catch (error) {
                    console.error("[hama-proxy] error handling delete request", error);
                    res.status(500).end("Error handling delete request");
                }
                return;
            }

            next();
        };
    }

    /**
     * 모든 연결 종료
     */
    async disconnectAll(): Promise<void> {
        console.log('🔌 모든 Hama 서버 연결 종료 중...');
        
        // SSE 전송 종료
        for (const transport of this.activeSSETransports.values()) {
            try {
                await transport.close();
            } catch (error) {
                console.error('SSE transport 종료 실패:', error);
            }
        }
        this.activeSSETransports.clear();

        // Stream 전송 종료
        for (const { server, transport } of this.activeStreamTransports.values()) {
            try {
                await transport.close();
                await server.close();
            } catch (error) {
                console.error('Stream transport 종료 실패:', error);
            }
        }
        this.activeStreamTransports.clear();

        // Hama 연결 종료
        const disconnectionPromises = Array.from(this.hamaConnections.values()).map(async (connection) => {
            try {
                connection.active = false;
                await connection.client.close();
                console.log(`✅ ${connection.serverName} 연결 종료됨`);
            } catch (error) {
                console.error(`❌ ${connection.serverName} 연결 종료 실패:`, error);
            }
        });

        await Promise.allSettled(disconnectionPromises);
        this.hamaConnections.clear();
        console.log('🎉 모든 Hama 서버 연결 종료 완료');
    }
}

/**
 * Express 앱 및 서버 설정 (수정된 버전)
 */
const app = express();
const server = http.createServer(app);

// 개선된 Hama 관리자 생성
const hamaManager = new EnhancedHamaManager();

/**
 * 서버 시작시 모든 Hama 서버에 자동 연결
 */
async function initializeServer(): Promise<void> {
    try {
        await hamaManager.connectAllServers();
        console.log('🎉 개선된 Hama 프록시 서버 초기화 완료');
    } catch (error) {
        console.error('❌ 서버 초기화 실패:', error);
    }
}

/**
 * CORS 미들웨어
 */
app.use((req, res, next) => {
    if (req.headers.origin) {
        try {
            const origin = new URL(req.headers.origin);
            res.setHeader("Access-Control-Allow-Origin", origin.origin);
            res.setHeader("Access-Control-Allow-Credentials", "true");
            res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
            res.setHeader("Access-Control-Allow-Headers", "*");
            res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");
        } catch (error) {
            console.error("[hama-proxy] error parsing origin", error);
        }
    }

    if (req.method === "OPTIONS") {
        res.status(204).end();
        return;
    }

    next();
});

/**
 * Ping 미들웨어
 */
app.get('/ping', (req, res) => {
    res.status(200).end("pong");
});

/**
 * Body parser 미들웨어
 */
app.use(express.json());

/**
 * Hama 프로토콜 미들웨어들
 */
app.use(hamaManager.createSSEMiddleware());
app.use(hamaManager.createStreamMiddleware());

/**
 * REST API 라우트들
 */
app.get('/', (req, res) => {
    res.json({
        message: '개선된 통합 Hama 프록시 서버가 실행 중입니다',
        status: hamaManager.getConnectionStatus(),
        endpoints: {
            sse: '/sse',
            streamableHttp: '/hama',
            rest: {
                status: '/api/status',
                tools: '/api/tools',
                prompts: '/api/prompts',
                resources: '/api/resources'
            }
        }
    });
});

app.get('/api/status', (req, res) => {
    res.json(hamaManager.getConnectionStatus());
});

app.get('/api/tools', (req, res) => {
    res.json({ tools: hamaManager.getUnifiedTools() });
});

app.get('/api/prompts', (req, res) => {
    res.json({ prompts: hamaManager.getUnifiedPrompts() });
});

app.get('/api/resources', (req, res) => {
    res.json({ resources: hamaManager.getUnifiedResources() });
});

app.post('/api/tools', async (req, res) => {
    try {
        const { name, arguments: toolArgs = {} } = req.body;
        
        if (!name) {
            return res.status(400).json({
                error: 'Tool name is required',
                code: 'MISSING_TOOL_NAME'
            });
        }

        
        const result = await hamaManager.callTool(name, toolArgs);
        
        console.log(`✅ 도구 호출 성공: ${name}`);
        res.json({
            success: true,
            result: result
        });
        
    } catch (error) {
        console.error(`❌ 도구 호출 실패: ${error}`);
        
        res.status(500).json({
            error: error instanceof Error ? error.message : 'Unknown error',
            code: 'TOOL_CALL_FAILED'
        });
    }
});

/**
 * 프로세스 종료 처리
 */
process.on('SIGINT', async () => {
    console.log('서버 종료 중...');
    await hamaManager.disconnectAll();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('서버 종료 중...');
    await hamaManager.disconnectAll();
    process.exit(0);
});

/**
 * 서버 시작
 */
const PORT = process.env.PORT || 3000;

async function startServer(): Promise<void> {
    // Hama 서버들에 먼저 연결
    await initializeServer();
    
    // HTTP 서버 시작
    server.listen(PORT, () => {
        const status = hamaManager.getConnectionStatus();
        console.log(`Hama 프록시 서버 시작 - 포트 ${PORT}`);
        console.log(`연결된 서버: ${status.activeConnections}/${status.totalServers}개`);
        console.log(`사용 가능한 도구: ${status.totalTools}개`);
        console.log(`서버 목록: ${status.connectedServers.join(', ')}`);
    });
}

// 서버 시작
startServer().catch(error => {
    console.error('서버 시작 실패:', error);
    process.exit(1);
});
