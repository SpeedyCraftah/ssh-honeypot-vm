import Pino from "pino";

export const logger = Pino({
    transport: { target: "pino-pretty" }
});