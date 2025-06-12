import http from 'http';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { autoRegisterServices, container } from './common/utils/tsyringe';
import MainRouter, { IMainRouter } from './common/routes/MainRouter';
import Cachable from './common/classes/cache/Cachable';

require('dotenv').config()

export const ROOTDIR = __dirname;

const PORT = 8080;

let server: http.Server | undefined;

process.on('unhandledRejection', (reason: any, promise) => {
    console.error('Unhandled Rejection at:', promise);

    let errorInfo = 'Unknown location';
    let errorMessage = 'Unknown error';
    let errorStack = '';

    if (reason && typeof reason === 'object') {
        // Check for custom error properties
        if (reason.data && reason.data.message) {
            errorMessage = reason.data.message;
        } else if (reason.message) {
            errorMessage = reason.message;
        }

        // Try to get the stack trace
        if (reason.stack) {
            errorStack = reason.stack;
            const stackLines = errorStack.split('\n');
            // Look for the first line in the stack that refers to your code
            const relevantLine = stackLines.find(line => line.includes('/Sites/doomdoomtech-api/'));

            if (relevantLine) {
                // Extract file path and line number using regex
                const match = relevantLine.match(/(\S+\.js):(\d+):(\d+)/);
                if (match) {
                    const [, filePath, lineNumber, columnNumber] = match;
                    errorInfo = `File: ${filePath}, Line: ${lineNumber}, Column: ${columnNumber}`;
                }
            }
        }
    } else {
        errorMessage = String(reason);
    }

    console.error('Error Message:', errorMessage);
    console.error('Location:', errorInfo);
    if (errorStack) {
        console.error('Stack Trace:');
        console.error(errorStack);
    }
});

async function initialize() {

    await autoRegisterServices();

    const app = express();
    server = http.createServer(app);

    app.set("trust proxy", "loopback");

    app.use(
        cors({
            origin: "*",
            exposedHeaders: ["x-session-id"],
            credentials: true,
            allowedHeaders: ["x-session-id", "x-device-id", "authorization", "content-type"],
        })
    );

    app.use(express.static(path.join(__dirname, "public")));
    app.use(express.json())
    app.use(express.urlencoded({ extended: true }));

    await Cachable.deleteMany([
        "users:*",
    ]);

    const mainRouter = container.resolve<IMainRouter>("MainRouter");
    app.use("/", mainRouter.getRouter());

    server.listen(PORT, "0.0.0.0", () => {
        console.log(`Server is listening on port ${PORT}`);
    });
}

initialize();