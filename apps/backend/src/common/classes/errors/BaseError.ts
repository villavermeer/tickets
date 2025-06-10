export interface ErrorInterface {
	status: number
	message: string
}

export default class BaseError {

	protected readonly data: ErrorInterface

	constructor(data: ErrorInterface) {
		this.data = data
	}

	public getStatusCode(): number {
		return this.data.status
	}

	public getMessage(): string {
		return this.data.message
	}
}