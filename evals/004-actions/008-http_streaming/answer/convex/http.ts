import { httpRouter } from "convex/server";
import { httpAction, query } from "./_generated/server";
import { v } from "convex/values";

const http = httpRouter();

http.route({
  path: "/stream",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    // Create a TransformStream to process the input line by line
    const transform = new TransformStream<string, string>({
      transform(chunk, controller) {
        // Calculate line length and format as SSE message
        const lineLength = chunk.length;
        const message = `data: {"lineLength": ${lineLength}}\n\n`;
        controller.enqueue(message);
      },
    });

    // Create a TextDecoderStream to convert the input bytes to text
    const textDecoder = new TextDecoderStream();
    // Create a line break transform stream
    const lineBreaker = new TransformStream<string, string>({
      transform(chunk, controller) {
        // Split the chunk by newlines and enqueue each line
        const lines = chunk.split("\n");
        for (const line of lines) {
          if (line) controller.enqueue(line);
        }
      },
      flush(controller) {
        // Ensure any remaining data is processed
        controller.terminate();
      }
    });

    try {
      // Chain the streams together with error handling
      const responseStream = request.body!
        .pipeThrough(textDecoder)
        .pipeThrough(lineBreaker)
        .pipeThrough(transform);

      // Return the streaming response with explicit error handling
      return new Response(responseStream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        },
      });
    } catch (error) {
      // Handle any streaming errors
      console.error('Streaming error:', error);
      return new Response("Internal Server Error", { status: 500 });
    }
  }),
});

export const getSiteURL = query({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    return process.env.CONVEX_SITE_URL!;
  },
});

export default http;