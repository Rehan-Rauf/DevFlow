require("dotenv").config();

const { searchKnowledge } = require("./services/vectorSearchService");

async function test() {
  console.log("================================");
  console.log("VECTOR SEARCH TEST");
  console.log("================================");

  try {
    const query = "web app project";
    const organizationId = 5;
    const userId = Number(process.env.DEVFLOW_TEST_USER_ID);
    if (!Number.isSafeInteger(userId) || userId <= 0) {
      throw new Error("Set DEVFLOW_TEST_USER_ID to an authorized user before running this probe.");
    }

    console.log("Query:", query);
    console.log("Organization:", organizationId);

    const results = await searchKnowledge({
      query,
      userId,
      organizationId,
    });

    console.log("\nResults:");

    if (!results || results.length === 0) {
      console.log("No results found.");
    } else {
      results.forEach((item, index) => {
        console.log(`\n--- Result ${index + 1} ---`);
        console.log("ID:", item.id);
        console.log("Type:", item.source_type);
        console.log("Source ID:", item.source_id);
        console.log("Similarity:", item.similarity);
        console.log("Content:", item.content);
      });
    }

    console.log("\n================================");
    console.log("VECTOR SEARCH SUCCESS");
    console.log("================================");
  } catch (error) {
    console.error("Vector search failed:");
    console.error(error);
  }
}

test();