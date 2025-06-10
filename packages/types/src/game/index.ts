export interface GameInterface {
    id: number;
    name: string;
    expires: "MIDDAY" | "MIDNIGHT" | "CUSTOM";
}