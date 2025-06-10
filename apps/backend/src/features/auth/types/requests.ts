export interface AuthenticatedRequest {
    authID: number
}

export interface CreateUserRequest {
	password: string
    name: string
    username: string
    role: string
    commission: number
}

export interface AuthorizeRequest {
    username: string
    password: string
}