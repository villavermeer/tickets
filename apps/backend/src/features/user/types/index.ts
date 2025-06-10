import { $Enums } from "@prisma/client";

export interface UserInterface {
    id: number;
    name: string;
    role: $Enums.Role;
    username: string;
    commission: number;
    runners: UserInterface[] | null;
    manager: UserInterface | null;
}