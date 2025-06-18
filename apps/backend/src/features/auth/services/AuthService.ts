import { inject, injectable } from "tsyringe"
import { AuthorizeRequest, CreateUserRequest } from "../types/requests"
import { ExtendedPrismaClient } from "../../../common/utils/prisma"
import { UserInterface } from "../../user/types"
import Service from "../../../common/services/Service"
import EntityNotFoundError from "../../../common/classes/errors/EntityNotFoundError"
import bcrypt from "bcrypt"
import jwt from "jsonwebtoken";
import ValidationError from "../../../common/classes/errors/ValidationError"
import { Role } from "@prisma/client"
import { UserMapper } from "../../user/mappers/UserMapper"
import { Context } from "../../../common/utils/context"

export interface IAuthService {
	authorize(data: AuthorizeRequest): Promise<{ user: UserInterface, token: string }>
	register(data: CreateUserRequest): Promise<void>
}

@injectable()
class AuthService extends Service implements IAuthService {

	constructor(
		@inject("Database") protected db: ExtendedPrismaClient
	) { super() }

	public authorize = async (data: AuthorizeRequest): Promise<{ user: UserInterface, token: string }> => {
		const user = await this.db.user.findUnique({
			where: {
				username: data.username.toLowerCase()
			}
		});

		if (!user) {
			throw new EntityNotFoundError("User")
		}

		const isPasswordValid = await bcrypt.compare(data.password, user.password);

		if (!isPasswordValid) {
			throw new ValidationError("Verkeerde gebruikersnaam of wachtwoord")
		}

		const token = jwt.sign(
			{ id: user.id },
			process.env.TOKEN_SECRET || 'default-secret'
		);

		return { user: UserMapper.format(user), token }
	}

	public register = async (data: CreateUserRequest): Promise<void> => {
		const createdUser = await this.db.user.create({
			data: {
				name: data.name,
				username: data.username,
				role: data.role as Role,
				commission: Number(data.commission),
				password: await bcrypt.hash(data.password, 10),
			}
		})

		if (data.managerID) {
			await this.db.managerRunner.create({
				data: {
					managerID: data.managerID,
					runnerID: createdUser.id
				}
			})
		}
	}
}



AuthService.register()