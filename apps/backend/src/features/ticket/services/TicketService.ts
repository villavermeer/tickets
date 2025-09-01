import { Prisma, Ticket } from "@prisma/client";
import Service from "../../../common/services/Service";
import { injectable } from "tsyringe";
import { CreateTicketRequest } from "../types/requests";
import ValidationError from "../../../common/classes/errors/ValidationError";
import { TicketMapper } from "../mappers/TicketMapper";
import { TicketInterface, UpdateTicketRequest, ExportTicketRequest, RelayableTicketOverview, ChunkedRelayableTicket } from "@tickets/types";
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
    getRelayableTickets(start: string, end: string, commit?: boolean): Promise<ChunkedRelayableTicket[]>;
    exportRelayableTickets(start: string, end: string, commit?: boolean): Promise<ExcelJS.Buffer>;
    exportRelayableTicketsPDF(start: string, end: string, commit?: boolean, compact?: boolean): Promise<Buffer>;
    delete(id: number): Promise<void>;
}

@injectable()
export class TicketService extends Service implements ITicketService {

    private DAILY_LIMITS = {
        // Daily maximum per code number (total from all users)
        CODE_MAX_SUPER4: 500, // 5 euro total per code for super4
        CODE_MAX_DEFAULT: 1000, // 10 euro total per code for 4-number games
        
        // Daily maximum per user per code
        USER_SUPER4: 100, // 1 euro per user per code for super4
        USER_DEFAULT: 500  // 5 euro per user per code for 4-number games
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

        // Check daily limits for all codes
        await this.checkDailyLimits(data.codes, data.games, data.runnerID, nowNL);

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

    public exportRelayableTickets = async (start: string, end: string, commit?: boolean): Promise<ExcelJS.Buffer> => {
        console.debug("Exporting relayable tickets with data:", { start, end, commit });
        const relayableTickets = await this.getRelayableTickets(start, end, commit);
        console.debug(`Fetched ${relayableTickets.length} relayable ticket combinations for export.`);

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Relayable Tickets');

        // Add report header
        worksheet.addRow(['Relayable Tickets Report']);
        worksheet.addRow([`Period: ${start} to ${end}`]);
        worksheet.addRow([`Generated: ${new Date().toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam' })}`]);
        worksheet.addRow([]); // Empty row for spacing

        // Add deduction rules
        worksheet.addRow(['Deduction Rules:']);
        worksheet.addRow(['• 4-digit: deduct €1.00 above €1.00 (€0.50 for Super 4)']);
        worksheet.addRow(['• 3-digit: deduct €2.00 for €3.00–€6.99, €5.00 for €7.00+ (Super 4: €0.50 for €2.50+)']);
        worksheet.addRow(['• 2-digit: deduct 50% for €25.00+ (not played for Super 4)']);
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
            const titleRow = worksheet.addRow([`Game Combination ${idx + 1}: ${chunk.gameCombination.join(', ')}`]);
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
            chunk.entries.forEach(entry => {
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

    public exportRelayableTicketsPDF = async (start: string, end: string, commit?: boolean, compact?: boolean): Promise<Buffer> => {
        console.debug("Exporting relayable tickets to PDF with data:", { start, end, commit, compact });
        const relayableTickets = await this.getRelayableTickets(start, end, commit);
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

                const left = doc.page.margins.left;
                const right = doc.page.width - doc.page.margins.right;
                const usableWidth = right - left;
                const pageBottomY = doc.page.height - doc.page.margins.bottom;

                let y = doc.page.margins.top;

                const ensureSpace = (needed: number) => { if (y + needed > pageBottomY) { doc.addPage(); y = doc.page.margins.top; } };

                const drawReportHeader = () => {
                    // Calculate actual height needed for header content
                    const titleHeight = 28; // Main title
                    const periodHeight = 18; // Period line
                    const generatedHeight = 24; // Generated timestamp
                    const rulesTitleHeight = 18; // "Deduction Rules:" title
                    
                    // Calculate height for deduction rules (they might wrap to multiple lines)
                    doc.font('Helvetica').fontSize(10);
                    const rules = [
                        '• 4-digit: deduct €1.00 above €1.00 (€0.50 for Super 4)',
                        '• 3-digit: deduct €2.00 for €3.00–€6.99, €5.00 for €7.00+ (Super 4: €0.50 for €2.50+)',
                        '• 2-digit: deduct 50% for €25.00+ (not played for Super 4)'
                    ];
                    
                    let totalRulesHeight = 0;
                    rules.forEach(rule => {
                        const ruleHeight = doc.heightOfString(rule, { width: usableWidth });
                        totalRulesHeight += ruleHeight;
                    });
                    
                    const totalHeaderHeight = titleHeight + periodHeight + generatedHeight + rulesTitleHeight + totalRulesHeight + 10; // +10 for final spacing
                    ensureSpace(totalHeaderHeight);
                    
                    doc.font('Helvetica-Bold').fontSize(20).text('Relayable Tickets Report', left, y, { width: usableWidth, align: 'center' });
                    y += titleHeight;
                    doc.font('Helvetica').fontSize(12).text(`Period: ${start} to ${end}`, left, y, { width: usableWidth, align: 'center' });
                    y += periodHeight;
                    doc.text(`Generated: ${new Date().toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam' })}`, left, y, { width: usableWidth, align: 'center' });
                    y += generatedHeight;

                    doc.font('Helvetica-Bold').fontSize(13).text('Deduction Rules:', left, y);
                    y += rulesTitleHeight;
                    doc.font('Helvetica').fontSize(10);
                    
                    rules.forEach(rule => { 
                        const ruleHeight = doc.heightOfString(rule, { width: usableWidth });
                        doc.text(rule, left, y, { width: usableWidth }); 
                        y += ruleHeight; 
                    });
                    y += 10;
                };

                const drawTableHeader = (x: number, headerY: number, colXs: number[], isCompact: boolean) => {
                    doc.font('Helvetica-Bold').fontSize(10);
                    doc.text(isCompact ? 'Code (x qty)' : 'Code', colXs[0], headerY);
                    doc.text('Value (€)', colXs[1], headerY);
                    doc.text('Deduction (€)', colXs[2], headerY);
                    doc.text('Final (€)', colXs[3], headerY);
                    doc.moveTo(x, headerY + 14).lineTo(x + usableWidth, headerY + 14).stroke();
                    // Reset to regular font after drawing headers
                    doc.font('Helvetica').fontSize(10);
                };

                drawReportHeader();

                const colXsBase = (xStart: number) => [xStart, xStart + 160, xStart + 280, xStart + 380];

                relayableTickets.forEach((chunk, idx) => {
                    // Calculate height needed for the title to account for potential wrapping
                    const titleText = `Game Combination ${idx + 1}: ${chunk.gameCombination.join(', ')}`;
                    const titleHeight = doc.heightOfString(titleText, { width: usableWidth });
                    // Ensure we have enough space for title + summary + table header + at least one row
                    const neededSpace = titleHeight + 18 + 24 + 14 + 20; // title + summary + table header + one row + buffer
                    ensureSpace(neededSpace);
                    
                    doc.font('Helvetica-Bold').fontSize(13).text(titleText, left, y, { width: usableWidth });
                    y += titleHeight + 6; // Add actual height plus small spacing

                    // Ensure regular font for summary text - explicitly reset after bold title
                    doc.font('Helvetica').fontSize(11);
                    const summary = [
                        `Total Value: €${(chunk.totalValue / 100).toFixed(2)}`,
                        `Deduction: €${(chunk.deduction / 100).toFixed(2)}`,
                        `Final Value: €${(chunk.finalValue / 100).toFixed(2)}`,
                        `Number of Codes: ${chunk.entries.length}`
                    ];
                    summary.forEach(line => { 
                        ensureSpace(14); 
                        // Ensure regular font for each summary line
                        doc.font('Helvetica').fontSize(11);
                        doc.text(line, left, y); 
                        y += 14; 
                    });
                    y += 6;

                    // Build rows: compact groups identical codes with same codeLength (rules depend on length)
                    type Row = { label: string; value: number; deduction: number; final: number };
                    let rows: Row[] = [];
                    if (compact) {
                        const grouped = _.groupBy(chunk.entries, e => `${e.code}-${e.codeLength}-${e.deduction}`);
                        rows = Object.values(grouped).map(list => {
                            const qty = list.length;
                            const sample = list[0];
                            return {
                                label: `${sample.code} (x${qty})`,
                                value: list.reduce((a, e) => a + e.value, 0),
                                deduction: list.reduce((a, e) => a + e.deduction, 0),
                                final: list.reduce((a, e) => a + e.final, 0)
                            };
                        });
                    } else {
                        rows = chunk.entries.map(e => ({ label: e.code, value: e.value, deduction: e.deduction, final: e.final }));
                    }

                    ensureSpace(24);
                    const cols = colXsBase(left);
                    const headerY = y;
                    drawTableHeader(left, headerY, cols, !!compact);
                    y = headerY + 18;

                    // Ensure regular font for table data
                    doc.font('Helvetica').fontSize(10);
                    for (let i = 0; i < rows.length; i++) {
                        if (y + 14 > pageBottomY) { 
                            doc.addPage(); 
                            y = doc.page.margins.top; 
                            drawTableHeader(left, y, cols, !!compact); 
                            y += 18; 
                            // Ensure regular font after page break and header redraw
                            doc.font('Helvetica').fontSize(10);
                        }
                        const r = rows[i];
                        // Ensure we're using regular font for each row - no need to set font multiple times
                        doc.text(r.label, cols[0], y);
                        doc.text((r.value / 100).toFixed(2), cols[1], y);
                        doc.text((r.deduction / 100).toFixed(2), cols[2], y);
                        doc.text((r.final / 100).toFixed(2), cols[3], y);
                        y += 14;
                    }

                    y += 12;
                });

                ensureSpace(20);
                doc.font('Helvetica').fontSize(8).text('Grouped by game combination for easy entry into the second app.', left, y, { width: usableWidth, align: 'center' });

                doc.end();
            } catch (err) { reject(err); }
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

    public getRelayableTickets = async (start: string, end: string, commit?: boolean): Promise<ChunkedRelayableTicket[]> => {
        
        // if(Context.get('authID') !== 1) {
        //     throw new ValidationError('Je hebt geen toegang tot deze functionaliteit');
        // }
        
        if (commit) {
            const { results } = await this.commitRelayableTickets(start, end);
            return results as unknown as ChunkedRelayableTicket[];
        }

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

        return this.buildRelayableChunks(codes);
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
            const value = item.value as number; // in cents
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

            // Calculate total value for all codes in this group
            const totalGroupValue = aggregatedEntries.reduce((sum, entry) => sum + entry.value, 0);
            const totalGroupValueInEuros = totalGroupValue / 100;
            const hasSuper4 = group.gameIds.includes(7);

            // Apply threshold filtering based on total group value instead of individual codes
            let shouldIncludeGroup = false;
            
            if (hasSuper4) {
                // Super 4 threshold rules - check if any code length meets the threshold
                const has4Digits = aggregatedEntries.some(entry => entry.codeLength === 4);
                const has3Digits = aggregatedEntries.some(entry => entry.codeLength === 3);
                
                if (has4Digits && totalGroupValueInEuros >= 1.00) {
                    shouldIncludeGroup = true; // 4 digits: from 1.00 euro
                } else if (has3Digits && totalGroupValueInEuros >= 2.50) {
                    shouldIncludeGroup = true; // 3 digits: from 2.50 euro
                }
                // 2 digits: always excluded for Super 4
            } else {
                // Non-Super4 threshold rules - check if any code length meets the threshold
                const has4Digits = aggregatedEntries.some(entry => entry.codeLength === 4);
                const has3Digits = aggregatedEntries.some(entry => entry.codeLength === 3);
                const has2Digits = aggregatedEntries.some(entry => entry.codeLength === 2);
                
                if (has4Digits && totalGroupValueInEuros >= 1.00) {
                    shouldIncludeGroup = true; // 4 digits: from 1.00 euro
                } else if (has3Digits && totalGroupValueInEuros >= 3.00) {
                    shouldIncludeGroup = true; // 3 digits: from 3.00 euro
                } else if (has2Digits && totalGroupValueInEuros >= 25.00) {
                    shouldIncludeGroup = true; // 2 digits: from 25.00 euro
                }
            }

            if (!shouldIncludeGroup) {
                return; // Skip this group if it doesn't meet the threshold
            }

            // Apply deduction to the total group value instead of individual codes
            const { deduction, finalValue } = this.calculateDeductionForTotal(totalGroupValue, group.gameIds);
            
            // Create entries with proportional deductions and filter out codes with 0 or negative final values
            const entriesDetailed = aggregatedEntries
                .map(e => {
                    // Calculate proportional deduction for each code based on its share of the total
                    const proportion = e.value / totalGroupValue;
                    const proportionalDeduction = Math.round(deduction * proportion);
                    const proportionalFinal = e.value - proportionalDeduction;
                    
                    return { 
                        code: e.code, 
                        codeLength: e.codeLength, 
                        value: e.value, 
                        deduction: proportionalDeduction, 
                        final: proportionalFinal 
                    };
                })
                .filter(e => e.final > 0); // Only include codes with positive final values

            chunks.push({
                gameCombination: group.gameNames,
                codes: entriesDetailed.map(e => e.code),
                totalValue: totalGroupValue,
                ticketCount: entriesDetailed.length,
                deduction,
                finalValue,
                entries: entriesDetailed
            });
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
            const tickets = await tx.ticket.findMany({
                where: { created: { gte: new Date(start), lte: new Date(end) } },
                select: { id: true }
            });

            const allCodes = await tx.code.findMany({
                where: { ticketID: { in: tickets.map(t => t.id) }, relayed: null },
                include: { ticket: { include: { games: { include: { game: true } } } } }
            });

            // First aggregate all codes by code number PER GAME (not by combination)
            const codeGroups = _.groupBy(allCodes, item => {
                const games = (item.ticket?.games || []);
                // For each game on a ticket, we will create separate group keys.
                // Since groupBy expects a single key, we will map beforehand.
                // Convert to synthetic records of (gameId, gameName, code, value)
                return games.map((tg: any) => {
                    const gId = tg.game?.id;
                    const gName = tg.game?.name;
                    if (typeof gId === 'number' && typeof gName === 'string') {
                        return `${gId === 7 ? 'S4' : 'G'}:${gId}:${gName}:${item.code}`;
                    }
                    return `IGNORE:${item.code}`;
                }).join('|');
            });

            // Filter aggregated codes based on threshold requirements
            const toRelay = Object.entries(codeGroups).flatMap(([key, entries]) => {
                // Parse key to determine gameId context
                const parts = key.split('|')[0].split(':');
                const isS4 = parts[0] === 'S4';
                const codeSample = String(entries[0].code);
                const codeLength = codeSample.length;
                const totalValue = entries.reduce((sum, entry) => sum + entry.value, 0);
                const valueInEuros = totalValue / 100;

                let meetsThreshold = false;
                if (isS4) {
                    if (codeLength === 4) {
                        meetsThreshold = valueInEuros >= 1.00;
                    } else if (codeLength === 3) {
                        meetsThreshold = valueInEuros >= 2.50;
                    } else if (codeLength === 2) {
                        meetsThreshold = false;
                    }
                } else {
                    if (codeLength === 4) {
                        meetsThreshold = valueInEuros >= 1.00;
                    } else if (codeLength === 3) {
                        meetsThreshold = valueInEuros >= 3.00;
                    } else if (codeLength === 2) {
                        meetsThreshold = valueInEuros >= 25.00;
                    }
                }

                return meetsThreshold ? entries : [];
            });

            const batch = await tx.relayBatch.create({ data: { start: new Date(start), end: new Date(end)} });

            if (toRelay.length) {
                await tx.code.updateMany({
                    where: { id: { in: toRelay.map(c => c.id) } },
                    data: { relayed: new Date(), relayBatchID: batch.id }
                });
            }

            const results = this.buildRelayableChunks(toRelay);
            return { batchID: batch.id, results };
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
        const isSuper4 = games.includes(7);
        const userDailyLimit = this.DAILY_LIMITS[isSuper4 ? 'USER_SUPER4' : 'USER_DEFAULT'];
        const codeDailyLimit = this.DAILY_LIMITS[isSuper4 ? 'CODE_MAX_SUPER4' : 'CODE_MAX_DEFAULT'];
        
        // Get start and end of current day in Amsterdam timezone
        const startOfDay = nowNL.startOf('day').toJSDate();
        const endOfDay = nowNL.endOf('day').toJSDate();

        // Track codes that exceed limits
        const userExceededCodes: string[] = [];
        const codeClosedCodes: string[] = [];
        
        for (const newCode of codes) {
            const codeString = newCode.code.toString();
            const newCodeValue = parseInt(newCode.value.toString(), 10);
            
            // Check if it's a 4-number code (only apply limits to 4-number codes)
            if (codeString.length !== 4) {
                continue;
            }
            
            // 1. Check total daily maximum for this code (from all users)
            const totalPlayedForCodeAllUsers = await this.db.code.findMany({
                where: {
                    code: codeString,
                    ticket: {
                        created: {
                            gte: startOfDay,
                            lte: endOfDay
                        },
                        // Only count codes from tickets that include the same game type
                        games: {
                            some: {
                                gameID: isSuper4 ? 7 : { not: 7 }
                            }
                        }
                    }
                },
                select: {
                    value: true
                }
            });
            
            const totalPlayedAllUsers = totalPlayedForCodeAllUsers.reduce((acc, code) => acc + code.value, 0);
            
            // Check if adding this value would exceed the code's daily maximum
            if (totalPlayedAllUsers + newCodeValue > codeDailyLimit) {
                codeClosedCodes.push(codeString);
                continue; // Skip user limit check if code is already closed
            }
            
            // 2. Check user daily limit for this code
            const userPlayedForCode = await this.db.code.findMany({
                where: {
                    code: codeString,
                    ticket: {
                        creatorID: runnerID,
                        created: {
                            gte: startOfDay,
                            lte: endOfDay
                        },
                        // Only count codes from tickets that include the same game type
                        games: {
                            some: {
                                gameID: isSuper4 ? 7 : { not: 7 }
                            }
                        }
                    }
                },
                select: {
                    value: true
                }
            });

            const userPlayedToday = userPlayedForCode.reduce((acc, code) => acc + code.value, 0);
            
            // Check if adding the new value would exceed the user's daily limit
            if (userPlayedToday + newCodeValue > userDailyLimit) {
                userExceededCodes.push(codeString);
            }
        }

        // Throw appropriate errors
        if (codeClosedCodes.length > 0) {
            throw new ValidationError(`De volgende nummers zijn gesloten (dagelijkse maximum bereikt): ${codeClosedCodes.join(", ")}`);
        }
        
        if (userExceededCodes.length > 0) {
            const limitInEuros = (userDailyLimit / 100).toFixed(2);
            throw new ValidationError(`Je hebt de dagelijkse limiet van €${limitInEuros} overschreden voor: ${userExceededCodes.join(", ")}`);
        }
    }
}

TicketService.register()
TicketService.register()