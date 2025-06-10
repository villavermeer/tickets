import Image from "next/image";

export default function Home() {
	return (
		<div className="flex justify-center items-center h-screen w-screen bg-[#00A09C]">
			<a href="/tickets.apk" download>
				<button className="bg-white text-black px-4 py-2 rounded-md">
					Download app
				</button>
			</a>
		</div>
	);
}
