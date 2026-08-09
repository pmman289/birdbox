export interface AuthSession {
  id: string;
  address: string;
  userAgent: string;
  createdAt: number;
  expiresAt: number;
  current: boolean;
}

export interface AuthStatusResponse {
  configured: boolean;
  authenticated: boolean;
  username: "admin";
  singleSession: false;
}

export interface AuthMutationResponse extends AuthStatusResponse {
  ok: true;
}

export interface AuthSessionsResponse {
  sessions: AuthSession[];
}

export interface RevokeAuthSessionResponse {
  ok: true;
  current: boolean;
}

export interface RevokeOtherAuthSessionsResponse {
  ok: true;
  revoked: number;
}
