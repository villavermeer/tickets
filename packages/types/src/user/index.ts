export type UserRole = "MANAGER" | "RUNNER" | "ADMIN"

export interface UserInterface {
    id: number
    name: string
    username: string
    role: UserRole
}