import {inject, singleton} from 'tsyringe';
import Service from '../../../common/services/Service';
import {ExtendedPrismaClient} from '../../../common/utils/prisma';
import {CreateRaffleRequest} from '../types/requests';
import { RaffleInterface } from '@tickets/types/dist/raffle';
import EntityNotFoundError from '../../../common/classes/errors/EntityNotFoundError';
import { RaffleMapper } from '../mappers/RaffleMapper';

export interface IRaffleService {
    save(data: Array<CreateRaffleRequest>): Promise<void>
    today(): Promise<Array<RaffleInterface>>
    all(): Promise<Array<RaffleInterface>>
    find(id: number): Promise<RaffleInterface>
    date(date: Date): Promise<Array<RaffleInterface>>
}

@singleton()
class RaffleService extends Service implements IRaffleService {

    constructor(
        @inject('Database') protected db: ExtendedPrismaClient
    ) {
        super()
    }

    public async find(id: number) {
        const raffle = await this.db.raffle.findUnique({
            where: {
                id: id
            },
            select: RaffleMapper.getSelectableFields()
        })

        if(!raffle) throw new EntityNotFoundError("Raffle")

        return RaffleMapper.format(raffle)
    }

    public async save(data: Array<CreateRaffleRequest>) {
        const today = new Date();
        today.setUTCHours(0, 0, 0, 0);

        for (const raffle of data) {
            if(!raffle.raffleID) continue;

            const savedRaffle = await this.db.raffle.upsert({
                where: {
                    id: raffle.raffleID
                },
                create: {
                    gameID: raffle.gameID
                },
                update: {}
            });

            await this.db.code.createMany({
                data: raffle.codes.map(code => ({
                    value: 0,
                    raffleID: savedRaffle.id,
                    code: code
                }))
            });
        }
    }

    public async all() {
        const raffles = await this.db.raffle.findMany({
            select: RaffleMapper.getSelectableFields()
        });

        return RaffleMapper.formatMany(raffles);
    }

    public async today() {
        const raffle = await this.db.raffle.findMany({
            select: RaffleMapper.getSelectableFields(),
            where: {
                created: {
                    gte: new Date(new Date().setHours(0, 0, 0, 0))
                }
            }
        });

        return RaffleMapper.formatMany(raffle);
    }

    public async date(date: Date) {
        const raffles = await this.db.raffle.findMany({
            select: RaffleMapper.getSelectableFields(),
            where: {
                created: {
                    gte: new Date(date.setHours(0, 0, 0, 0)),
                    lte: new Date(date.setHours(23, 59, 59, 999))
                }
            }
        });

        return RaffleMapper.formatMany(raffles);
    }
}

RaffleService.register()