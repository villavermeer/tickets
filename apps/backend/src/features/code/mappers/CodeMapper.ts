import { Prisma, Code } from "@prisma/client";
import { CodeInterface } from "../types";
import { TicketMapper } from "../../ticket/mappers/TicketMapper";

export type SelectableCodeFields = Prisma.CodeGetPayload<{
    select: ReturnType<typeof CodeMapper.getSelectableFields>
}>;

export class CodeMapper {

    public static getSelectableFields(): Prisma.CodeSelect {
        return {
            id: true,
            code: true,
            value: true,
        }
    }

    public static format(code: any): CodeInterface {
        return {
            id: code.id ?? 0,
            code: code.code ?? '',
            value: code.value ?? 0
        };
    }

    public static formatMany(codes: Code[]): CodeInterface[] {
        return codes.map(code => CodeMapper.format(code));
    }
}
