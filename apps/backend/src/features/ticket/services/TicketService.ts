import { Prisma, Ticket } from "@prisma/client";
import Service from "../../../common/services/Service";
import { injectable } from "tsyringe";
import { CreateTicketRequest } from "../types/requests";
import ValidationError from "../../../common/classes/errors/ValidationError";
import { TicketMapper } from "../mappers/TicketMapper";
import { TicketInterface, UpdateTicketRequest, ExportTicketRequest, RelayableTicketOverview, ChunkedRelayableTicket, RelayableTicketEntry } from "@tickets/types";
import ExcelJS from "exceljs";
import _ from "lodash";
import { v4 } from "uuid";
import { Context } from "../../../common/utils/context";
import { DateTime } from "luxon";
import PDFDocument from "pdfkit";

export interface ITicketService {
    all(start: string, end: string, managerID?: string, runnerID?: string): Promise<TicketInterface[]>;
    runner(runnerID: number, date?: Date): Promise<TicketInterface[]>;
    manager(managerID: number): Promise<TicketInterface[]>;
    raffle(raffleID: number, start?: string, end?: string): Promise<TicketInterface[]>;
    create(data: CreateTicketRequest): Promise<Ticket | null>;
    update(id: number, data: UpdateTicketRequest): Promise<Ticket | null>;
    export(data: ExportTicketRequest): Promise<ExcelJS.Buffer>;
    getRelayableTickets(start: string, end: string, commit?: boolean, combineAcrossGames?: boolean): Promise<ChunkedRelayableTicket[]>;
    exportRelayableTickets(start: string, end: string, commit?: boolean, combineAcrossGames?: boolean): Promise<ExcelJS.Buffer>;
    exportRelayableTicketsPDF(start: string, end: string, commit?: boolean, compact?: boolean, combineAcrossGames?: boolean): Promise<Buffer>;
    delete(id: number): Promise<void>;
}

@injectable()
export class TicketService extends Service implements ITicketService {

    private DAILY_LIMITS = {
        GLOBAL: {
            DEFAULT: {
                4: 1000, // 10 euro total per 4-digit code (non Super4)
                3: 5000  // 50 euro total per 3-digit code (non Super4)
            },
            SUPER4: {
                4: 500,  // 5 euro total per 4-digit code (Super4)
                3: 1000  // 10 euro total per 3-digit code (Super4)
            }
        },
        USER: {
            DEFAULT: {
                4: 500,  // 5 euro per user per 4-digit code (non Super4)
                3: 500   // 5 euro per user per 3-digit code (non Super4)
            },
            SUPER4: {
                4: 100,  // 1 euro per user per 4-digit code (Super4)
                3: 500   // 5 euro per user per 3-digit code (Super4)
            }
        }
    }

    public all = async (start: string, end: string, managerID?: string, runnerID?: string): Promise<TicketInterface[]> => {
        const startDate = new Date(start);
        const endDate = new Date(end);

        // Set startDate to beginning of the day (00:00:00.000)
        startDate.setUTCHours(0, 0, 0, 0);
        // Set endDate to end of the day (23:59:59.999)
        endDate.setUTCHours(23, 59, 59, 999);

        // Get the current user's details
        const user = Context.get("user");

        if (user.role === 'MANAGER' && !managerID) {
            managerID = user.id.toString();
        }

        const whereClause: Prisma.TicketWhereInput = {
            created: {
                gte: startDate,
                lte: endDate
            },
            codes: {
                some: {
                    ticketID: {
                        not: null
                    }
                }
            }
        };

        // Role-based filtering
        if (user.role === 'RUNNER') {
            // Runners can only see their own tickets
            whereClause.creatorID = user.id;
        } else {
            // For managers or other roles, apply filters based on managerID or runnerID
            if (managerID) {
                whereClause.creatorID = Number(managerID)
            }
            if (runnerID) {
                whereClause.creatorID = Number(runnerID);
            }
        }

        // Fetch the tickets from the database
        const tickets = await this.db.ticket.findMany({
            select: TicketMapper.getSelectableFields(),
            orderBy: { created: 'desc' },
            where: whereClause
        });

        // Format and return the results
        return tickets.map(TicketMapper.format);
    }

    public raffle = async (raffleID: number, start?: string, end?: string): Promise<TicketInterface[]> => {
        const whereClause: any = {
            raffleID: raffleID,
        };

        if (start || end) {
            whereClause.created = {};
            if (start) {
                whereClause.created.gte = new Date(start);
            }
            if (end) {
                whereClause.created.lte = new Date(end);
            }
        }

        const tickets = await this.db.ticket.findMany({
            where: whereClause,
            select: TicketMapper.getSelectableFields(),
        });

        return tickets.map(TicketMapper.format);
    };

    public async create(data: CreateTicketRequest): Promise<Ticket | null> {
        /* -------------------------------------------------------------
        * Calculate the strictest cut-off for the selected games
        * ------------------------------------------------------------ */
        const nowNL = DateTime.now().setZone("Europe/Amsterdam");

        // Load the game names that belong to the ticket
        const games = await this.db.game.findMany({
            where: { id: { in: data.games } },
            select: { id: true, name: true },
        });

        if (games.length !== data.games.length) {
            throw new ValidationError("Er is iets misgegaan bij het aanmaken van het ticket.");
        }

        // Check daily limits for all codes (skip for admin accounts)
        const user = Context.get("user");
        if (user.role !== 'ADMIN') {
            await this.checkDailyLimits(data.codes, data.games, data.runnerID, nowNL);
        }

        // Compute the earliest cut-off among all chosen games
        const earliestCutOff = games
            .map((g) => this.getCutOffForGame(g.name, nowNL))
            .reduce((earliest, cur) => (cur < earliest ? cur : earliest));

        if (nowNL >= earliestCutOff) {
            const list = games.map((g) => g.name).join(", ");
            throw new ValidationError(
                `Tickets voor ${list} moeten voor ${earliestCutOff.toFormat("HH:mm")} worden aangemaakt.`
            );
        }
       
        // Use a transaction to ensure data consistency
        return await this.db.$transaction(async (tx) => {
            const ticket = await tx.ticket.create({
                data: {
                    name: data.name,
                    creatorID: data.runnerID,
                    codes: {
                        create: data.codes.map((code) => ({ 
                            code: code.code,
                            value: parseInt(code.value.toString(), 10),
                            relayed: data.relayed ? new Date() : null,
                        })),
                    },
                },
            });

            // Create all TicketGame records in a single operation to avoid sequence issues
            if (data.games.length > 0) {
                await tx.ticketGame.createMany({
                    data: data.games.map((game) => ({
                        ticketID: ticket.id,
                        gameID: game,
                    })),
                });
            }

            return ticket;
        });
    }

    public update = async (id: number, data: UpdateTicketRequest): Promise<Ticket | null> => {
        // check if the ticket exists
        const ticket = await this.db.ticket.findUnique({
            where: { id }
        });
        
        if (!ticket) {
            throw new ValidationError('Ticket niet gevonden');
        }

        // check if the ticket was created today (same day editing only)
        const today = new Date();
        const ticketCreatedDate = new Date(ticket.created);
        
        // Set both dates to start of day for comparison
        const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
        const ticketDateStart = new Date(ticketCreatedDate.getFullYear(), ticketCreatedDate.getMonth(), ticketCreatedDate.getDate());
        
        if (todayStart.getTime() !== ticketDateStart.getTime()) {
            throw new ValidationError('Tickets kunnen alleen worden bewerkt op dezelfde dag als ze zijn aangemaakt');
        }

        // update the ticket
        const updatedTicket = await this.db.ticket.update({
            where: {
                id
            },
            data: {
                name: data.name,
            },
        });

        // Handle games with smart update to preserve created timestamps
        if (data.games) {
            // Get existing games for this ticket
            const existingGames = await this.db.ticketGame.findMany({
                where: { ticketID: id },
                select: { id: true, gameID: true, created: true }
            });

            // Find games to delete (existing but not in new data)
            const gamesToDelete = existingGames.filter(eg => 
                !data.games.includes(eg.gameID)
            );

            // Find games to create (in new data but not existing)
            const gamesToCreate = data.games.filter(gameId => 
                !existingGames.some(eg => eg.gameID === gameId)
            );

            // Delete removed games
            if (gamesToDelete.length > 0) {
                await this.db.ticketGame.deleteMany({
                    where: { id: { in: gamesToDelete.map(g => g.id) } }
                });
            }

            // Create new games with preserved timestamps using raw SQL
            for (const gameId of gamesToCreate) {
                const now = new Date();
                await this.db.$executeRaw`
                    INSERT INTO ticket_games ("ticketID", "gameID", created, updated)
                    VALUES (${id}, ${gameId}, ${now}, ${now})
                `;
            }
        }

        // Handle codes with smart update to preserve created timestamps
        if (data.codes) {
            // Get existing codes for this ticket
            const existingCodes = await this.db.code.findMany({
                where: { ticketID: id },
                select: { id: true, code: true, value: true, created: true }
            });

            // Find codes to delete (existing but not in new data)
            const codesToDelete = existingCodes.filter(ec => 
                !data.codes.some(newCode => 
                    newCode.code.toString() === ec.code && 
                    parseInt(newCode.value.toString(), 10) === ec.value
                )
            );

            // Find codes to create (in new data but not existing)
            const codesToCreate = data.codes.filter(newCode => 
                !existingCodes.some(ec => 
                    ec.code === newCode.code.toString() && 
                    ec.value === parseInt(newCode.value.toString(), 10)
                )
            );
            
            // Check daily limits for new codes (only if there are new codes to create)
            if (codesToCreate.length > 0) {
                // Get the current games for this ticket (use updated games if provided, otherwise existing)
                let currentGames = data.games;
                if (!currentGames) {
                    const existingTicketGames = await this.db.ticketGame.findMany({
                        where: { ticketID: id },
                        select: { gameID: true }
                    });
                    currentGames = existingTicketGames.map(tg => tg.gameID);
                }
                
                const nowNL = DateTime.now().setZone("Europe/Amsterdam");
                await this.checkDailyLimits(codesToCreate, currentGames, ticket.creatorID, nowNL);
            }

            // Delete removed codes
            if (codesToDelete.length > 0) {
                await this.db.code.deleteMany({
                    where: { id: { in: codesToDelete.map(c => c.id) } }
                });
            }

            // Create new codes with preserved timestamps using raw SQL
            for (const code of codesToCreate) {
                const now = new Date();
                await this.db.$executeRaw`
                    INSERT INTO codes (code, value, "ticketID", created, updated)
                    VALUES (${code.code.toString()}, ${parseInt(code.value.toString(), 10)}, ${id}, ${now}, ${now})
                `;
            }
        }

        // Fetch the updated ticket to return
        const finalTicket = await this.db.ticket.findUnique({
            where: { id }
        });

        return finalTicket
    }

    public runner = async (runnerID: number, date?: Date): Promise<TicketInterface[]> => {

        if (!date) {
            date = new Date();
        }

        const startOfDay = new Date(date.getTime());
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date(date.getTime());
        endOfDay.setHours(23, 59, 59, 999);

        const tickets = await this.db.ticket.findMany({
            select: TicketMapper.getSelectableFields(),
            where: {
                creatorID: runnerID,
                created: {
                    gte: startOfDay,
                    lte: endOfDay
                }
            },
            orderBy: {
                created: 'desc'
            }
        });

        return tickets.map(TicketMapper.format);
    }

    public manager = async (managerID: number): Promise<TicketInterface[]> => {

        // Step 1: Get runners managed by this manager
        const managerRunners = await this.db.managerRunner.findMany({
            where: {
                managerID: managerID
            },
            select: {
                runnerID: true
            }
        });


        // Step 2: Extract runner IDs
        const runnerIDs = managerRunners.map((mr) => mr.runnerID);

        // If there are no runners, return an empty array
        if (runnerIDs.length === 0) {
            return [];
        }

        // Step 3: Query tickets with those runnerIDs
        const tickets = await this.db.ticket.findMany({
            select: TicketMapper.getSelectableFields(),
            where: {
                creatorID: {
                    in: runnerIDs
                }
            },
            orderBy: {
                created: 'desc'
            }
        });

        return tickets.map(TicketMapper.format);
    }

    public export = async (data: ExportTicketRequest): Promise<ExcelJS.Buffer> => {
        console.debug("Exporting tickets with data:", data);
        const tickets = await this.all(data.startDate, data.endDate);
        console.debug(`Fetched ${tickets.length} tickets for export.`);

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Tickets');

        worksheet.addRow([
            "Datum", 'Uniek nummer', 'Naam klant', 'Naam loper', 'Naam manager',
            'Trekking', 'Nummer', 'Inleg', 'Tijd indienen ticket'
        ]);

        // Pre-fetch all manager names for runners to minimize database calls
        const runnerIDs = tickets
            .filter(ticket => ticket.creator.role === 'RUNNER')
            .map(ticket => ticket.creator.id);

        const runnerManagerMap = await this.db.managerRunner.findMany({
            where: {
                runnerID: { in: runnerIDs }
            },
            select: {
                runnerID: true,
                manager: {
                    select: {
                        name: true
                    }
                }
            }
        });

        const managerNameMap = new Map<number, string>();
        runnerManagerMap.forEach(rm => {
            if (rm.manager) {
                managerNameMap.set(rm.runnerID, rm.manager.name);
            }
        });

        tickets.forEach(ticket => {
            console.debug("Processing ticket:", ticket.id);
            let runnerName = '-';
            let managerName = '-';

            if (ticket.creator.role === 'MANAGER') {
                managerName = ticket.creator.name;
            } else if (ticket.creator.role === 'RUNNER') {
                runnerName = ticket.creator.name;
                managerName = managerNameMap.get(ticket.creator.id) || '-';
            }

            ticket.games.forEach(game => {
                console.debug("Processing game:", game.name);
                ticket.codes.forEach(code => {
                    console.debug("Adding row for code:", code.code);
                    worksheet.addRow([
                        ticket.created.toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam' }),
                        v4(),
                        ticket.name,
                        runnerName,
                        managerName,
                        game.name,
                        code.code,
                        (code.value / 100).toFixed(2).replace('.', ','),
                        ticket.created.toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam' })
                    ]);
                });
            });
        });

        // Generate buffer
        const buffer = await workbook.xlsx.writeBuffer();
        console.debug("Export buffer generated successfully.");

        return buffer;
    }

    public exportRelayableTickets = async (start: string, end: string, commit?: boolean, combineAcrossGames?: boolean): Promise<ExcelJS.Buffer> => {
        console.debug("Exporting relayable tickets with data:", { start, end, commit });
        const relayableTickets = await this.getRelayableTickets(start, end, commit, combineAcrossGames);
        console.debug(`Fetched ${relayableTickets.length} relayable ticket combinations for export.`);

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Relayable Tickets');

        // Add report header
        worksheet.addRow([]); // Empty row for spacing

        // Style the report header
        const reportHeaderRow = worksheet.getRow(1);
        reportHeaderRow.font = { bold: true, size: 16 };
        reportHeaderRow.alignment = { horizontal: 'center' };

        const periodRow = worksheet.getRow(2);
        periodRow.font = { bold: true, size: 12 };
        periodRow.alignment = { horizontal: 'center' };

        const generatedRow = worksheet.getRow(3);
        generatedRow.font = { size: 10 };
        generatedRow.alignment = { horizontal: 'center' };

        const rulesTitleRow = worksheet.getRow(5);
        rulesTitleRow.font = { bold: true, size: 11 };

        const rulesRows = [6, 7, 8];
        rulesRows.forEach(rowNum => {
            const row = worksheet.getRow(rowNum);
            row.font = { size: 10 };
        });

        // Process each game combination
        relayableTickets.forEach((chunk, idx) => {
            // Add game combination title
            const titleRow = worksheet.addRow([`${chunk.gameCombination.join(', ')}`]);
            titleRow.font = { bold: true, size: 12 };
            titleRow.fill = {
                type: 'pattern',
                pattern: 'solid',
                fgColor: { argb: 'FFD3D3D3' }
            };

            // Add summary
            worksheet.addRow([`Total Value: €${(chunk.totalValue / 100).toFixed(2)}`]);
            worksheet.addRow([`Deduction: €${(chunk.deduction / 100).toFixed(2)}`]);
            worksheet.addRow([`Final Value: €${(chunk.finalValue / 100).toFixed(2)}`]);
            worksheet.addRow([`Number of Codes: ${chunk.entries.length}`]);
            worksheet.addRow([]); // Empty row for spacing

            // Add table header
            const tableHeaderRow = worksheet.addRow(['Code', 'Value (€)', 'Final Value (€)']);
            tableHeaderRow.font = { bold: true };
            tableHeaderRow.fill = {
                type: 'pattern',
                pattern: 'solid',
                fgColor: { argb: 'FFE0E0E0' }
            };

            // Add table data (only code, value, and final value - no deduction)
            chunk.entries.forEach((entry: RelayableTicketEntry) => {
                worksheet.addRow([
                    entry.code,
                    (entry.value / 100).toFixed(2),
                    (entry.final / 100).toFixed(2)
                ]);
            });

            worksheet.addRow([]); // Empty row for spacing between game combinations
        });

        // Auto-fit columns
        worksheet.columns.forEach(column => {
            column.width = Math.max(
                column.width || 0,
                Math.max(...column.values?.map(v => String(v).length) || [0])
            );
        });

        // Generate buffer
        console.log('About to generate Excel buffer...');
        const buffer = await workbook.xlsx.writeBuffer();
        console.log('Excel buffer generated successfully. Buffer type:', typeof buffer);
        console.log('Buffer constructor:', buffer.constructor.name);
        console.log('Buffer properties:', Object.keys(buffer));
        console.log('Buffer length property:', (buffer as any).length);
        console.debug("Relayable tickets export buffer generated successfully.");

        return buffer;
    }

    public exportRelayableTicketsPDF = async (start: string, end: string, commit?: boolean, _compact?: boolean, combineAcrossGames?: boolean): Promise<Buffer> => {
        console.debug("Exporting relayable tickets to PDF with data:", { start, end, commit });
        const relayableTickets = await this.getRelayableTickets(start, end, commit, combineAcrossGames);
        console.debug(`Fetched ${relayableTickets.length} relayable ticket combinations for PDF export.`);

        return new Promise((resolve, reject) => {
            try {
                const doc = new PDFDocument({
                    size: 'A4',
                    margins: { top: 40, bottom: 40, left: 40, right: 40 }
                });

                const chunks: Buffer[] = [];
                doc.on('data', (chunk: Buffer) => chunks.push(chunk));
                doc.on('end', () => resolve(Buffer.concat(chunks)));
                doc.on('error', reject);

                const left = doc.page.margins.left;
                const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
                const bottomLimit = doc.page.height - doc.page.margins.bottom;
                const rowHeight = 22;
                const columnWidths = [Math.floor(usableWidth * 0.6), Math.ceil(usableWidth * 0.4)];
                const generatedStamp = new Date().toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam' });

                const renderReportHeader = (subtitle?: string) => {
                    doc.fillColor('#000000');
                    if (subtitle) {
               
                        doc.font('Helvetica-Bold').fontSize(14).text(subtitle, left, doc.y, { width: usableWidth });
                    }
                    doc.moveDown(0.6);
                };

                const drawTableHeader = (y: number) => {
                    doc.save();
                    doc.rect(left, y, usableWidth, rowHeight).fill('#f2f4f7');
                    doc.fillColor('#000000');
                    doc.font('Helvetica-Bold').fontSize(11)
                        .text('Code', left + 8, y + 6, { width: columnWidths[0] - 16 });
                    doc.text('Bedrag', left + columnWidths[0], y + 6, { width: columnWidths[1] - 16, align: 'right' });
                    doc.restore();
                };

                const drawTableRow = (entry: RelayableTicketEntry, y: number, isStriped: boolean) => {
                    doc.save();
                    if (isStriped) {
                        doc.rect(left, y, usableWidth, rowHeight).fill('#fbfcfe');
                    }
                    doc.fillColor('#000000');
                    doc.font('Helvetica').fontSize(11)
                        .text(entry.code, left + 8, y + 6, { width: columnWidths[0] - 16 });
                    doc.text((entry.final / 100).toFixed(2), left + columnWidths[0], y + 6, { width: columnWidths[1] - 16, align: 'right' });
                    doc.restore();
                };

                if (!relayableTickets.length) {
                    renderReportHeader('Geen relaybare tickets gevonden');
                    doc.end();
                    return;
                }

                let isFirstPage = true;

                relayableTickets.forEach((chunk, chunkIndex) => {
                    let entryIndex = 0;
                    let pageForChunk = 0;
                    const combinationTitle = `${chunk.gameCombination.join(', ')}`;

                    while (entryIndex < chunk.entries.length || pageForChunk === 0) {
                        if (!isFirstPage) {
                            doc.addPage();
                        }
                        isFirstPage = false;

                        const subtitle = pageForChunk > 0 ? `${combinationTitle} (vervolg)` : combinationTitle;
                        renderReportHeader(subtitle);

                        let y = doc.y;
                        drawTableHeader(y);
                        y += rowHeight;

                        let stripe = false;
                        while (entryIndex < chunk.entries.length) {
                            if (y + rowHeight > bottomLimit) {
                                break;
                            }
                            const entry = chunk.entries[entryIndex];
                            drawTableRow(entry, y, stripe);
                            stripe = !stripe;
                            y += rowHeight;
                            entryIndex++;
                        }

                        if (entryIndex >= chunk.entries.length) {
                            if (y + 24 > bottomLimit) {
                                doc.addPage();
                                renderReportHeader(`${combinationTitle} (vervolg)`);
                                y = doc.y;
                            } else {
                                y += 12;
                            }
                        }

                        pageForChunk++;
                    }
                });

                doc.end();
            } catch (err) {
                reject(err);
            }
        });
    }

    public delete = async (id: number): Promise<void> => {

        // check if the user owns the ticket
        const ticket = await this.db.ticket.findUnique({
            where: { id }
        });

        if (!ticket) {
            throw new ValidationError('Ticket not found');
        }

        if (ticket.creatorID !== Context.get('authID')) {
            throw new ValidationError('You are not allowed to delete this ticket');
        }

        // check if the ticket was created today (same day editing only)
        const today = new Date();
        const ticketCreatedDate = new Date(ticket.created);
        
        // Set both dates to start of day for comparison
        const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
        const ticketDateStart = new Date(ticketCreatedDate.getFullYear(), ticketCreatedDate.getMonth(), ticketCreatedDate.getDate());
        
        if (todayStart.getTime() !== ticketDateStart.getTime()) {
            throw new ValidationError('Tickets kunnen alleen worden verwijderd op dezelfde dag als ze zijn aangemaakt');
        }

        // delete all codes
        await this.db.code.deleteMany({
            where: { ticketID: id }
        });

        // delete all games
        await this.db.ticketGame.deleteMany({
            where: { ticketID: id }
        });

        await this.db.ticket.delete({
            where: { id }
        });
    }

    public getRelayableTickets = async (start: string, end: string, commit?: boolean, combineAcrossGames?: boolean): Promise<ChunkedRelayableTicket[]> => {
        
        // if(Context.get('authID') !== 1) {
        //     throw new ValidationError('Je hebt geen toegang tot deze functionaliteit');
        // }
        
        let results: ChunkedRelayableTicket[];
        
        if (commit) {
            const commitResponse = await this.commitRelayableTickets(start, end);
            results = commitResponse.results as unknown as ChunkedRelayableTicket[];
        } else {
            // Parse and normalize date parameters for better demo usability
            const startDate = this.parseDateParameter(start, true);
            const endDate = this.parseDateParameter(end, false);

            const tickets = await this.db.ticket.findMany({
                where: {
                    created: {
                        gte: startDate,
                        lte: endDate
                    }
                },
                select: { id: true }
            });

            const codes = await this.db.code.findMany({
                where: {
                    ticketID: { in: tickets.map(ticket => ticket.id) },
                    relayed: null,
                },
                include: {
                    ticket: {
                        include: {
                            games: { include: { game: true } }
                        }
                    }
                }
            });

            // For non-commit exports, we want incremental results that account for prior commits earlier the same day
            results = await this.buildRelayableChunksIncremental(codes, startDate, endDate);
        }

        if (!combineAcrossGames) {
            return results;
        }

        // Combine across games by (code, per-game final). We sum value/deduction across games
        // but keep the per-game final amount unchanged by grouping on it.
        type EntryAgg = { code: string; codeLength: number; final: number; valueSum: number; deductionSum: number; games: Set<string> };
        const byCodeFinal = new Map<string, Map<number, EntryAgg>>();
        results.forEach(chunk => {
            chunk.entries.forEach((e: RelayableTicketEntry) => {
                const code = e.code;
                const finalKey = e.final; // cents
                let inner = byCodeFinal.get(code);
                if (!inner) { inner = new Map<number, EntryAgg>(); byCodeFinal.set(code, inner); }
                let agg = inner.get(finalKey);
                if (!agg) {
                    agg = { code, codeLength: e.codeLength, final: finalKey, valueSum: 0, deductionSum: 0, games: new Set<string>() };
                    inner.set(finalKey, agg);
                }
                agg.valueSum += e.value;
                agg.deductionSum += e.deduction;
                chunk.gameCombination.forEach((g: string) => agg!.games.add(g));
            });
        });

        // Now group aggregated entries by their union-of-games signature
        const groupsByGames = new Map<string, { gameList: string[]; entries: { code: string; codeLength: number; value: number; deduction: number; final: number }[] }>();
        for (const inner of byCodeFinal.values()) {
            for (const agg of inner.values()) {
                const gameList = Array.from(agg.games).sort();
                const gameKey = gameList.join(', ');
                const group = groupsByGames.get(gameKey) || { gameList, entries: [] };
                group.entries.push({
                    code: agg.code,
                    codeLength: agg.codeLength,
                    value: agg.valueSum,
                    deduction: agg.deductionSum,
                    final: agg.final
                });
                groupsByGames.set(gameKey, group);
            }
        }

        // Emit one chunk per game-list with multiple code rows
        const combinedChunks: ChunkedRelayableTicket[] = Array.from(groupsByGames.values()).map(g => ({
            gameCombination: g.gameList,
            codes: g.entries.map(e => e.code),
            totalValue: g.entries.reduce((s, x) => s + x.value, 0),
            ticketCount: g.entries.length,
            deduction: g.entries.reduce((s, x) => s + x.deduction, 0),
            finalValue: g.entries.reduce((s, x) => s + x.final, 0),
            entries: g.entries
        }));

        return _.sortBy(combinedChunks, c => c.gameCombination.join('|'));
    }

    // Build chunks but compute per-code incremental values for the selected window by
    // subtracting already-committed amounts earlier in the same day.
    private buildRelayableChunksIncrementalDetailed = async (codes: any[], windowStart: Date, _windowEnd: Date): Promise<{ chunks: ChunkedRelayableTicket[]; relayableCodeIds: number[] }> => {
        type GroupValue = { gameIds: number[]; gameNames: string[]; entries: { id: number; code: string; codeLength: number; value: number; }[] };
        type GroupKey = string;

        const groups = new Map<GroupKey, GroupValue>();
        const relayableCodeIds = new Set<number>();

        codes.forEach((item) => {
            const value = Number(item.value);
            const codeStr = String(item.code);
            const codeLength = codeStr.length;
            const gameIds: number[] = (item.ticket?.games || []).map((g: any) => g.game?.id).filter((id: any) => typeof id === 'number');
            const gameNames: string[] = (item.ticket?.games || []).map((g: any) => g.game?.name).filter((n: any) => typeof n === 'string');

            const hasSuper4 = gameIds.includes(7);

            // Add entries per individual non-Super4 game (not as a combination)
            const nonSuperGames = (item.ticket?.games || []).filter((g: any) => g.game?.id !== 7);
            nonSuperGames.forEach((g: any) => {
                const gId = g.game?.id;
                const gName = g.game?.name;
                if (typeof gId === 'number' && typeof gName === 'string') {
                    const key: GroupKey = `G:${gId}:${gName}`;
                    const existing: GroupValue = groups.get(key) || { gameIds: [gId], gameNames: [gName], entries: [] };
                    existing.entries.push({ id: item.id, code: codeStr, codeLength, value });
                    groups.set(key, existing);
                }
            });

            // Add Super 4 group separately if present
            if (hasSuper4) {
                const key: GroupKey = 'S4:Super 4';
                const existing: GroupValue = groups.get(key) || { gameIds: [7], gameNames: ['Super 4'], entries: [] };
                existing.entries.push({ id: item.id, code: codeStr, codeLength, value });
                groups.set(key, existing);
            }
        });

        // Determine the day window from the start time (assumes exports are per-day; if multi-day, use the first day)
        const dayStart = new Date(windowStart);
        dayStart.setUTCHours(0, 0, 0, 0);
        const dayEnd = new Date(windowStart);
        dayEnd.setUTCHours(23, 59, 59, 999);

        const chunks: ChunkedRelayableTicket[] = [];
        for (const group of Array.from(groups.values())) {
            const isSuper4 = group.gameIds.includes(7);
            // Aggregate values for the window per code
            const codeGroups = _.groupBy(group.entries, 'code');
            const windowAggregated: { code: string; codeLength: number; value: number; ids: number[] }[] = [];
            Object.entries(codeGroups).forEach(([code, entries]) => {
                const totalValue = entries.reduce((sum, entry) => sum + entry.value, 0);
                const codeLength = entries[0].codeLength;
                const ids = entries.map(e => e.id);
                windowAggregated.push({ code, codeLength, value: totalValue, ids });
            });

            if (windowAggregated.length === 0) continue;

            // Batch-fetch all codes for the day for this game context
            const ticketGameFilter: any = isSuper4 ? { some: { gameID: 7 } } : { some: { gameID: group.gameIds[0] } };
            const allDayForGame = await this.db.code.findMany({
                where: {
                    ticket: {
                        created: { gte: dayStart, lte: dayEnd },
                        games: ticketGameFilter
                    }
                },
                select: { code: true, value: true, relayed: true }
            });

            // Build maps: total by code and committed by code
            const totalByCode = new Map<string, number>();
            const committedByCode = new Map<string, number>();
            for (const c of allDayForGame) {
                const k = String(c.code);
                totalByCode.set(k, (totalByCode.get(k) || 0) + (c.value as number));
                if (c.relayed) committedByCode.set(k, (committedByCode.get(k) || 0) + (c.value as number));
            }

            // For each window code, compute daily totals and incremental amounts
            const entriesDetailed: { code: string; codeLength: number; value: number; deduction: number; final: number }[] = [];
            for (const e of windowAggregated) {
                const totalAllDay = totalByCode.get(e.code) || 0;
                const committedValue = committedByCode.get(e.code) || 0;

                // Apply threshold to full day sum
                const valueInEuros = totalAllDay / 100;
                let meetsThreshold = false;
                if (isSuper4) {
                    if (e.codeLength === 4) meetsThreshold = valueInEuros >= 1.00;
                    else if (e.codeLength === 3) meetsThreshold = valueInEuros >= 2.50;
                    else if (e.codeLength === 2) meetsThreshold = false;
                } else {
                    if (e.codeLength === 4) meetsThreshold = valueInEuros >= 1.25;
                    else if (e.codeLength === 3) meetsThreshold = valueInEuros >= 3.00;
                    else if (e.codeLength === 2) meetsThreshold = valueInEuros >= 25.00;
                }
                if (!meetsThreshold) continue;

                const dayCalc = this.calculateDeduction(e.codeLength, totalAllDay, group.gameIds);
                const committedCalc = committedValue > 0 ? this.calculateDeduction(e.codeLength, committedValue, group.gameIds) : { deduction: 0, finalValue: 0 };
                const incrementalFinal = dayCalc.finalValue - committedCalc.finalValue;
                if (incrementalFinal < 100) continue;

                const incrementalValue = e.value;
                const incrementalDeduction = Math.max(0, incrementalValue - incrementalFinal);

                entriesDetailed.push({ code: e.code, codeLength: e.codeLength, value: incrementalValue, deduction: incrementalDeduction, final: incrementalFinal });
                e.ids.forEach(id => relayableCodeIds.add(id));
            }

            if (!entriesDetailed.length) {
                continue;
            }

            const totalValue = entriesDetailed.reduce((s, x) => s + x.value, 0);
            const deduction = entriesDetailed.reduce((s, x) => s + x.deduction, 0);
            const finalValue = entriesDetailed.reduce((s, x) => s + x.final, 0);

            chunks.push({
                gameCombination: group.gameNames,
                codes: entriesDetailed.map(e => e.code),
                totalValue,
                ticketCount: entriesDetailed.length,
                deduction,
                finalValue,
                entries: entriesDetailed
            });
        }

        const sortedChunks = _.sortBy(chunks, c => c.gameCombination.join('|'));
        return { chunks: sortedChunks, relayableCodeIds: Array.from(relayableCodeIds) };
    }

    private buildRelayableChunksIncremental = async (codes: any[], windowStart: Date, windowEnd: Date): Promise<ChunkedRelayableTicket[]> => {
        const { chunks } = await this.buildRelayableChunksIncrementalDetailed(codes, windowStart, windowEnd);
        return chunks;
    }

    private parseDateParameter(dateParam: string, isStartDate: boolean): Date {
        // Handle various date formats for better demo usability
        
        // 1. If it's already an ISO string, parse directly
        if (dateParam.includes('T') || dateParam.includes('Z') || dateParam.includes('+')) {
            return new Date(dateParam);
        }
        
        // 2. Handle "YYYY-MM-DD" format - convert to start/end of day
        if (/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
            const date = new Date(dateParam);
            if (isStartDate) {
                // Start of day: 00:00:00.000
                date.setHours(0, 0, 0, 0);
            } else {
                // End of day: 23:59:59.999
                date.setHours(23, 59, 59, 999);
            }
            return date;
        }
        
        // 3. Handle "YYYY-MM-DD HH:MM" format
        if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(dateParam)) {
            return new Date(dateParam + ':00');
        }
        
        // 4. Handle "YYYY-MM-DD HH:MM:SS" format
        if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(dateParam)) {
            return new Date(dateParam);
        }
        
        // 5. Try to parse with Luxon for other formats
        try {
            const parsed = DateTime.fromFormat(dateParam, 'yyyy-MM-dd HH:mm:ss');
            if (parsed.isValid) {
                return parsed.toJSDate();
            }
        } catch (e) {
            // Continue to next format
        }
        
        // If none of the above work, try to parse as-is (will throw error if invalid)
        return new Date(dateParam);
    }

    private buildRelayableChunks = (codes: any[]): ChunkedRelayableTicket[] => {
        type GroupValue = { gameIds: number[]; gameNames: string[]; entries: { code: string; codeLength: number; value: number; }[] };
        type GroupKey = string;

        const groups = new Map<GroupKey, GroupValue>();

        codes.forEach((item) => {
            const value = item.value as number;
            const codeStr = String(item.code);
            const codeLength = codeStr.length;
            const gameIds: number[] = (item.ticket?.games || []).map((g: any) => g.game?.id).filter((id: any) => typeof id === 'number');
            const gameNames: string[] = (item.ticket?.games || []).map((g: any) => g.game?.name).filter((n: any) => typeof n === 'string');

            const hasSuper4 = gameIds.includes(7);

            // Add entries per individual non-Super4 game (not as a combination)
            const nonSuperGames = (item.ticket?.games || []).filter((g: any) => g.game?.id !== 7);
            nonSuperGames.forEach((g: any) => {
                const gId = g.game?.id;
                const gName = g.game?.name;
                if (typeof gId === 'number' && typeof gName === 'string') {
                    const key: GroupKey = `G:${gId}:${gName}`;
                    const existing: GroupValue = groups.get(key) || { gameIds: [gId], gameNames: [gName], entries: [] };
                    existing.entries.push({ code: codeStr, codeLength, value });
                    groups.set(key, existing);
                }
            });

            // Add Super 4 group separately if present
            if (hasSuper4) {
                const key: GroupKey = 'S4:Super 4';
                const existing: GroupValue = groups.get(key) || { gameIds: [7], gameNames: ['Super 4'], entries: [] };
                existing.entries.push({ code: codeStr, codeLength, value });
                groups.set(key, existing);
            }
        });

        const chunks: ChunkedRelayableTicket[] = [];
        groups.forEach((group) => {
            // Group entries by code number and calculate total value per code
            const codeGroups = _.groupBy(group.entries, 'code');
            const aggregatedEntries: { code: string; codeLength: number; value: number; }[] = [];
            
            Object.entries(codeGroups).forEach(([code, entries]) => {
                const totalValue = entries.reduce((sum, entry) => sum + entry.value, 0);
                const codeLength = entries[0].codeLength; // All entries for same code have same length
                aggregatedEntries.push({ code, codeLength, value: totalValue });
            });

            const hasSuper4 = group.gameIds.includes(7);

            // Filter out codes that don't meet the minimum value requirements BEFORE further processing
            const filteredEntries = aggregatedEntries.filter(entry => {
                const valueInEuros = entry.value / 100;
                if (hasSuper4) {
                    // Super 4 thresholds
                    if (entry.codeLength === 4) return valueInEuros >= 1.00;
                    if (entry.codeLength === 3) return valueInEuros >= 2.50;
                    if (entry.codeLength === 2) return false; // never played on Super4
                } else {
                    // Default game thresholds
                    if (entry.codeLength === 4) return valueInEuros >= 1.25; // 1.25+ then deduct 1
                    if (entry.codeLength === 3) return valueInEuros >= 3.00;  // 3-6.99 => -2, 7+ => -5
                    if (entry.codeLength === 2) return valueInEuros >= 25.00; // 25+ => halve
                }
                return false;
            });

            // If no codes meet the threshold requirements, skip this group entirely
            if (filteredEntries.length === 0) {
                return;
            }

            // Calculate per-code deductions and final values
            const entriesDetailed = filteredEntries
                .map(e => {
                    const { deduction, finalValue } = this.calculateDeduction(e.codeLength, e.value, group.gameIds);
                    return { code: e.code, codeLength: e.codeLength, value: e.value, deduction, final: finalValue };
                })
                .filter(e => e.final >= 100);

            // Aggregate totals from per-code results
            const totalGroupValue = entriesDetailed.reduce((sum, e) => sum + e.value, 0);
            const deduction = entriesDetailed.reduce((sum, e) => sum + e.deduction, 0);
            const finalValue = entriesDetailed.reduce((sum, e) => sum + e.final, 0);

            if (entriesDetailed.length) {
                chunks.push({
                    gameCombination: group.gameNames,
                    codes: entriesDetailed.map(e => e.code),
                    totalValue: totalGroupValue,
                    ticketCount: entriesDetailed.length,
                    deduction,
                    finalValue,
                    entries: entriesDetailed
                });
            }
        });

        return _.sortBy(chunks, c => c.gameCombination.join('|'));
    }

    private calculateDeduction = (codeLength: number, codeValue: number, gameIds: number[]): { deduction: number; finalValue: number } => {
        const hasSuper4 = gameIds.includes(7); 
        
        // Convert cents to euros for easier calculation
        const valueInEuros = codeValue / 100;
        let deductionInEuros = 0;

        if (hasSuper4) {
            // Super 4 rules
            if (codeLength === 4) {
                // 4 digits: Een euro of hoger gaat 0.50 vanaf
                if (valueInEuros >= 1) {
                    deductionInEuros = 0.50;
                }
            } else if (codeLength === 3) {
                // 3 digits: Alles vanaf 2.50 halen we 0.50 vanaf
                if (valueInEuros >= 2.50) {
                    deductionInEuros = 0.50;
                }
            } else if (codeLength === 2) {
                // 2 digits: Deze spelen we niet - should be filtered out
                return { deduction: 0, finalValue: 0 };
            }
        } else {
            // All games except Super 4
            if (codeLength === 4) {
                // 4 digits: Alles wat boven 1 euro gespeeld wordt halen we 1 euro vanaf
                if (valueInEuros > 1) {
                    deductionInEuros = 1;
                }
            } else if (codeLength === 3) {
                // 3 digits: Inleg van 3 tot 7 euro halen we 2 euro vanaf. Alles vanaf 7 euro of hoger halen we 5 euro vanaf
                if (valueInEuros >= 3 && valueInEuros < 7) {
                    deductionInEuros = 2;
                } else if (valueInEuros >= 7) {
                    deductionInEuros = 5;
                }
            } else if (codeLength === 2) {
                // 2 digits: Alles vanaf 25 euro gaat door de helft
                if (valueInEuros >= 25) {
                    deductionInEuros = valueInEuros / 2;
                }
            }
        }

        // Convert back to cents
        const deductionInCents = Math.round(deductionInEuros * 100);
        const finalValueInCents = codeValue - deductionInCents;

        return {
            deduction: deductionInCents,
            finalValue: finalValueInCents
        };
    }

    private calculateDeductionForTotal = (totalValue: number, gameIds: number[]): { deduction: number; finalValue: number } => {
        const hasSuper4 = gameIds.includes(7); 
        
        // Convert cents to euros for easier calculation
        const valueInEuros = totalValue / 100;
        let deductionInEuros = 0;

        if (hasSuper4) {
            // Super 4 rules - apply to total value
            if (valueInEuros >= 1.00) {
                // For Super 4, deduct 0.50 euro from total if >= 1.00 euro
                deductionInEuros = 0.50;
            }
        } else {
            // All games except Super 4 - apply to total value
            if (valueInEuros > 1.00) {
                // For non-Super4 games, deduct 1 euro from total if > 1.00 euro
                deductionInEuros = 1.00;
            }
        }

        // Convert back to cents
        const deductionInCents = Math.round(deductionInEuros * 100);
        const finalValueInCents = totalValue - deductionInCents;

        return {
            deduction: deductionInCents,
            finalValue: finalValueInCents
        };
    }

    private commitRelayableTickets = async (start: string, end: string) => {
        return await this.db.$transaction(async (tx) => {
            // Use the same date parsing logic as the non-commit path
            const startDate = this.parseDateParameter(start, true);
            const endDate = this.parseDateParameter(end, false);
            
            const tickets = await tx.ticket.findMany({
                where: { created: { gte: startDate, lte: endDate } },
                select: { id: true }
            });

            const allCodes = await tx.code.findMany({
                where: { ticketID: { in: tickets.map(t => t.id) }, relayed: null },
                include: { ticket: { include: { games: { include: { game: true } } } } }
            });

            const { chunks, relayableCodeIds } = await this.buildRelayableChunksIncrementalDetailed(allCodes, startDate, endDate);

            const batch = await tx.relayBatch.create({ data: { start: new Date(start), end: new Date(end) } });

            if (relayableCodeIds.length) {
                await tx.code.updateMany({
                    where: { id: { in: relayableCodeIds } },
                    data: { relayed: new Date(), relayBatchID: batch.id }
                });
            }

            return { batchID: batch.id, results: chunks };
        });
    }

    private getCutOffForGame(gameName: string, now: DateTime): DateTime {
        const weekday = now.weekday;           // 1 = Mon … 7 = Sun
        const isSunday = weekday === 7;
        const isNoonGame =
            gameName === "Philipsburg noon" || gameName === "Smart noon";

        // 17 : 00 every day for “noon” games
        if (isNoonGame) {
            return now.set({ hour: 17, minute: 0, second: 0, millisecond: 0 });
        }

        // 19 : 00 on Sunday for the “evening / regular” games
        if (isSunday) {
            return now.set({ hour: 19, minute: 0, second: 0, millisecond: 0 });
        }

        // 24 : 00 (00 : 00 next day) Mon-Sat for those games
        return now.plus({ days: 1 }).startOf("day"); // next-day midnight
    }

    private async checkDailyLimits(codes: any[], games: number[], runnerID: number, nowNL: DateTime): Promise<void> {
        const startOfDay = nowNL.startOf('day').toJSDate();
        const endOfDay = nowNL.endOf('day').toJSDate();

        const uniqueGameIds = Array.from(new Set(games));
        const gameNameRecords = uniqueGameIds.length
            ? await this.db.game.findMany({
                where: { id: { in: uniqueGameIds } },
                select: { id: true, name: true }
            })
            : [];
        const gameNameMap = new Map<number, string>(gameNameRecords.map(g => [g.id, g.name || `Game ${g.id}`]));

        type LimitBreach = { code: string; codeLength: number; gameID: number; limit: number };
        const globalBreaches: LimitBreach[] = [];
        const userBreaches: LimitBreach[] = [];
        const globalBreachKeys = new Set<string>();
        const userBreachKeys = new Set<string>();

        const globalTotalsCache = new Map<string, number>();
        const userTotalsCache = new Map<string, number>();
        const pendingGlobalAdds = new Map<string, number>();
        const pendingUserAdds = new Map<string, number>();

        const getLimit = (
            scope: 'GLOBAL' | 'USER',
            category: 'DEFAULT' | 'SUPER4',
            codeLength: number
        ): number | undefined => {
            const limits = this.DAILY_LIMITS[scope][category] as Record<number, number>;
            return limits[codeLength];
        };

        for (const newCode of codes) {
            const codeString = String(newCode.code);
            const codeLength = codeString.length;
            if (![3, 4].includes(codeLength)) {
                continue;
            }

            const newCodeValue = Number(newCode.value);

            for (const gameID of uniqueGameIds) {
                const category: 'DEFAULT' | 'SUPER4' = gameID === 7 ? 'SUPER4' : 'DEFAULT';
                const globalLimit = getLimit('GLOBAL', category, codeLength);
                const userLimit = getLimit('USER', category, codeLength);

                if (!globalLimit && !userLimit) {
                    continue;
                }

                const ticketWhereForGame: Prisma.TicketWhereInput = {
                    created: { gte: startOfDay, lte: endOfDay },
                    games: { some: { gameID } }
                };

                const cacheKeyBase = `${category}:${codeLength}:${gameID}:${codeString}`;

                if (globalLimit) {
                    const globalCacheKey = `${cacheKeyBase}:global`;
                    let currentTotal = globalTotalsCache.get(globalCacheKey);
                    if (currentTotal === undefined) {
                        const aggregate = await this.db.code.aggregate({
                            where: {
                                code: codeString,
                                ticket: ticketWhereForGame
                            },
                            _sum: { value: true }
                        });
                        currentTotal = aggregate._sum.value ?? 0;
                        globalTotalsCache.set(globalCacheKey, currentTotal);
                    }

                    const pendingAddition = pendingGlobalAdds.get(globalCacheKey) ?? 0;
                    const projectedTotal = currentTotal + pendingAddition + newCodeValue;

                    if (projectedTotal > globalLimit) {
                        const breachKey = globalCacheKey;
                        if (!globalBreachKeys.has(breachKey)) {
                            globalBreachKeys.add(breachKey);
                            globalBreaches.push({ code: codeString, codeLength, gameID, limit: globalLimit });
                        }
                        continue;
                    }

                    pendingGlobalAdds.set(globalCacheKey, pendingAddition + newCodeValue);
                }

                if (userLimit) {
                    const userCacheKey = `${cacheKeyBase}:user:${runnerID}`;
                    let currentUserTotal = userTotalsCache.get(userCacheKey);
                    if (currentUserTotal === undefined) {
                        const aggregate = await this.db.code.aggregate({
                            where: {
                                code: codeString,
                                ticket: {
                                    ...ticketWhereForGame,
                                    creatorID: runnerID
                                }
                            },
                            _sum: { value: true }
                        });
                        currentUserTotal = aggregate._sum.value ?? 0;
                        userTotalsCache.set(userCacheKey, currentUserTotal);
                    }

                    const pendingUserAddition = pendingUserAdds.get(userCacheKey) ?? 0;
                    const projectedUserTotal = currentUserTotal + pendingUserAddition + newCodeValue;

                    if (projectedUserTotal > userLimit) {
                        if (!userBreachKeys.has(userCacheKey)) {
                            userBreachKeys.add(userCacheKey);
                            userBreaches.push({ code: codeString, codeLength, gameID, limit: userLimit });
                        }
                        continue;
                    }

                    pendingUserAdds.set(userCacheKey, pendingUserAddition + newCodeValue);
                }
            }
        }

        if (globalBreaches.length) {
            const details = globalBreaches.map(breach => {
                const gameLabel = gameNameMap.get(breach.gameID) || `Game ${breach.gameID}`;
                return `${breach.code} (${breach.codeLength} cijfers, ${gameLabel}) – limiet €${(breach.limit / 100).toFixed(2)}`;
            }).join(', ');
            throw new ValidationError(`Deze codes hebben het dagelijkse maximum bereikt: ${details}`);
        }

        if (userBreaches.length) {
            const details = userBreaches.map(breach => {
                const gameLabel = gameNameMap.get(breach.gameID) || `Game ${breach.gameID}`;
                return `${breach.code} (${breach.codeLength} cijfers, ${gameLabel}) – limiet €${(breach.limit / 100).toFixed(2)}`;
            }).join(', ');
            throw new ValidationError(`Je hebt de persoonlijke limiet overschreden voor: ${details}`);
        }
    }
}

TicketService.register()
