import {Job, Queue, Worker as BULLMQWorker} from 'bullmq';
import Redis from 'ioredis';
import {inject} from 'tsyringe';

abstract class Worker {

	protected worker: BULLMQWorker;
	protected queue: Queue;

	protected constructor(
		protected readonly queueName: string,
		@inject("Redis") protected readonly connection: Redis
	) {
		this.queue = new Queue(queueName, {
			connection: this.connection,
			defaultJobOptions: {
				removeOnComplete: false,
				removeOnFail: false
			}
		});

		this.worker = new BULLMQWorker(
			queueName,
			this.processJob.bind(this),
			{
				connection: this.connection,
				concurrency: 5
			}
		);

		this.setupEventHandlers();
	}

	public async getQueueStatus() {
		const [waiting, active, completed, failed, delayed, repeatable] = await Promise.all([
			this.queue.getWaitingCount(),
			this.queue.getActiveCount(),
			this.queue.getCompletedCount(),
			this.queue.getFailedCount(),
			this.queue.getDelayedCount(),
			this.queue.getRepeatableJobs()
		]);

		return {
			waiting,
			active,
			completed,
			failed,
			delayed,
			repeatableJobs: repeatable
		};
	}

	protected abstract processJob(job: Job): Promise<void>;

	protected async removeJob(jobId: string) {
		try {
			const job = await this.queue.getJob(jobId);
			if (job && !job.opts.repeat) {
				await this.queue.remove(jobId);
			}
		} catch (error) {
			console.error('Error removing job:', jobId, error);
		}
	}

	private setupEventHandlers() {
		this.worker.on('completed', async (job) => {
			if (job.id && !job.opts.repeat) {
				await this.removeJob(job.id);
			}
		});

		this.worker.on('failed', async (job, err) => {
			console.error(`Job ${job?.id} failed:`, err);
			if (job && job.id && !job.opts.repeat) {
				await this.removeJob(job.id);
			}
		});

		this.worker.on('error', (error) => {
			console.error('Worker error:', error);
		});

		this.queue.on('error', (error) => {
			console.error('Queue error:', error);
		});
	}
}

export default Worker;