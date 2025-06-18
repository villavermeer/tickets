import { $Enums } from "@prisma/client";
import { RevenueResult } from "../../revenue/services/RevenueService";

export interface UserInterface {
    id: number;
    name: string;
    role: $Enums.Role;
    username: string;
    commission: number;
    runners: UserInterface[] | null;
    manager: UserInterface | null;
    password?: string;
}

export interface ManageUserRequest {
    id?: number;
    name: string;
    username: string;
    password: string;
    commission: number;
    role: $Enums.Role;
}