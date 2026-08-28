import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import {
	Form,
	FormControl,
	FormDescription,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { api } from "@/utils/api";

const nanoseconds = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const readinessRoutingFormSchema = z
	.object({
		enabled: z.boolean(),
		Path: z
			.string()
			.regex(/^\/\S*$/, "Path must start with / and contain no spaces"),
		Interval: nanoseconds,
		UnhealthyInterval: nanoseconds,
		Timeout: nanoseconds,
		Status: z.number().int().min(200).max(599),
	})
	.refine(({ Interval, Timeout }) => Interval > Timeout, {
		message: "Interval must be greater than Timeout",
		path: ["Interval"],
	});

type ReadinessRoutingFormValues = z.infer<typeof readinessRoutingFormSchema>;

const defaults: ReadinessRoutingFormValues = {
	enabled: false,
	Path: "/health",
	Interval: 500_000_000,
	UnhealthyInterval: 250_000_000,
	Timeout: 400_000_000,
	Status: 200,
};

export const ReadinessRoutingForm = ({
	applicationId,
}: {
	applicationId: string;
}) => {
	const application = api.application.one.useQuery(
		{ applicationId },
		{ enabled: !!applicationId },
	);
	const update = api.application.update.useMutation();
	const form = useForm<ReadinessRoutingFormValues>({
		resolver: zodResolver(readinessRoutingFormSchema),
		defaultValues: defaults,
	});

	useEffect(() => {
		const readiness = application.data?.readinessCheckSwarm;
		form.reset(readiness ? { enabled: true, ...readiness } : defaults);
	}, [application.data?.readinessCheckSwarm, form]);

	const onSubmit = async ({
		enabled,
		...readiness
	}: ReadinessRoutingFormValues) => {
		try {
			await update.mutateAsync({
				applicationId,
				readinessCheckSwarm: enabled ? readiness : null,
			});
			await application.refetch();
			toast.success("Readiness routing updated successfully");
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: "Error updating readiness routing",
			);
		}
	};

	const enabled = form.watch("enabled");

	return (
		<Form {...form}>
			<form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
				<FormField
					control={form.control}
					name="enabled"
					render={({ field }) => (
						<FormItem className="flex items-center justify-between rounded-lg border p-4">
							<div>
								<FormLabel>Fail-closed readiness routing</FormLabel>
								<FormDescription>
									Route application domains directly to healthy Swarm tasks. A
									task is not admitted before its first successful probe.
									Requires an explicit Traefik image with fail-closed initial
									health support.
								</FormDescription>
							</div>
							<FormControl>
								<Switch
									checked={field.value}
									onCheckedChange={field.onChange}
								/>
							</FormControl>
						</FormItem>
					)}
				/>

				{enabled && (
					<div className="grid gap-4 md:grid-cols-2">
						<FormField
							control={form.control}
							name="Path"
							render={({ field }) => (
								<FormItem className="md:col-span-2">
									<FormLabel>Readiness path</FormLabel>
									<FormControl>
										<Input placeholder="/health" {...field} />
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>
						{(
							[
								["Interval", "Healthy interval (nanoseconds)"],
								["UnhealthyInterval", "Unhealthy interval (nanoseconds)"],
								["Timeout", "Timeout (nanoseconds)"],
								["Status", "Expected HTTP status"],
							] as const
						).map(([name, label]) => (
							<FormField
								key={name}
								control={form.control}
								name={name}
								render={({ field }) => (
									<FormItem>
										<FormLabel>{label}</FormLabel>
										<FormControl>
											<Input
												type="number"
												{...field}
												onChange={(event) =>
													field.onChange(event.target.valueAsNumber)
												}
											/>
										</FormControl>
										<FormMessage />
									</FormItem>
								)}
							/>
						))}
					</div>
				)}

				<div className="flex justify-end">
					<Button type="submit" isLoading={update.isPending}>
						Save Readiness Routing
					</Button>
				</div>
			</form>
		</Form>
	);
};
