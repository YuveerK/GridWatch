import { GoogleGenAI, Type } from "@google/genai";
import "dotenv/config";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const outageSchema = {
  type: Type.OBJECT,
  properties: {
    suburb: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
    substation: { type: Type.STRING, nullable: true },
    cause: {
      type: Type.STRING,
      enum: [
        "cable_fault",
        "cable_theft",
        "planned_maintenance",
        "equipment_failure",
        "unknown",
      ],
    },
    status: {
      type: Type.STRING,
      enum: ["investigating", "planned", "restored"],
    },
    eta: { type: Type.STRING, nullable: true },
    confidence: { type: Type.STRING, enum: ["high", "low"] },
  },
  required: ["suburb", "cause", "status", "confidence"],
};

async function extractOutage(tweetText) {
  const response = await ai.models.generateContent({
    model: "gemini-3.1-flash-lite",
    contents: `Extract structured outage data from this City Power tweet:\n\n"${tweetText}"`,
    config: {
      responseMimeType: "application/json",
      responseSchema: outageSchema,
    },
  });

  return JSON.parse(response.text);
}

extractOutage(`#CityPowerUpdates
#HursthillSDC

Parkhurst Substation, Greenside South Distributor: Power supply has been partially restored in Greenside, Westcliff, Forest Town and surrounding areas. The team is unable to backfeed the affected areas due to existing faults.

Customers will be updated as more information becomes available.

We apologise for the inconvenience caused.

Customers in the vicinity who are without power are advised to log calls at http://citypower.mobi or call 011 490 7484/ 0800 202 925.

For more updates,please follow our WhatsApp channel at: https://whatsapp.com/channel/0029VaQ4cOKJZg46BROZ9s0S

^KM`)
  .then((outage) => console.log(JSON.stringify(outage, null, 2)))
  .catch((error) => {
    console.error("Failed to extract outage data:", error.message);
    process.exitCode = 1;
  });
