import {
  CloudWatchLogsClient,
  StartQueryCommand,
  GetQueryResultsCommand,
  QueryStatus,
} from "@aws-sdk/client-cloudwatch-logs";
import { fromIni } from "@aws-sdk/credential-providers"; // For loading AWS CLI profiles
import * as readline from "readline"; // For user input (MFA)
import * as fs from "fs/promises";     // For asynchronous file system operations (caching)
import * as path from "path";         // For resolving file paths (caching)

// --- Configuration ---
const LOG_GROUP_NAME = "/na3/queuer_19.0";
const AWS_REGION = "us-east-1"; // Explicitly set the region based on your config
const AWS_PROFILE = "na3_techsupport"; // Your AWS CLI profile name

// --- Time Range --- 24 hours until now
const ONE_DAY_IN_MS =8/60 * 60 * 60 * 1000; // Corrected to 20 hours for demonstration. Original was 20/60 hours which is too short.
const END_TIME_MS = Date.now();
const START_TIME_MS = END_TIME_MS - ONE_DAY_IN_MS;

const startDate = new Date(START_TIME_MS);
const endDate = new Date(END_TIME_MS);

// Print the exact date range
console.log(`⏱️ Time Range:`);
console.log(`FROM: ${startDate.toISOString()} (${startDate.toLocaleString()})`);
console.log(`TO:   ${endDate.toISOString()} (${endDate.toLocaleString()})`);

// --- Query String ---
const QUERY_STRING = `fields @timestamp, @message, @logStream, @log, requestURL, statusCode
| filter @message like "Launch SUCCESS" and logger="CallLauncher" and qProfile like '-auto' #and @messsage like "acd-19"
| parse logMessage "* * * * * * *" a,b,c,d,e,service,g
| display logTimestamp,qProfile,traceId,@logStream,logMessage, service
| limit 10000
#| stats count() as hits by qProfile
| stats count() as hits by service, qProfile
| sort hits DESC`;

// --- Credential Caching Setup ---
interface CachedCredentials {
  AccessKeyId: string;
  SecretAccessKey: string;
  SessionToken: string;
  Expiration: string; // ISO 8601 string
}

// Define the path for the cache file (within a hidden directory in the current working directory)
const CACHE_DIR = ".aws_cache";
const CACHE_FILE_NAME = `${AWS_PROFILE}_temp_credentials.json`;
const CACHE_FILE_PATH = path.join(process.cwd(), CACHE_DIR, CACHE_FILE_NAME);

/**
 * Helper function to prompt the user for an MFA token code.
 * @param mfaSerial The ARN of the MFA device.
 * @returns A promise that resolves with the MFA token code.
 */
async function promptForMfaCode(mfaSerial: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`Enter MFA code for ${mfaSerial}: `, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Reads cached temporary credentials from a file.
 * Returns null if file does not exist, is invalid, or credentials are expired.
 */
async function readCachedCredentials(): Promise<CachedCredentials | null> {
  try {
    const fileContent = await fs.readFile(CACHE_FILE_PATH, { encoding: 'utf8' });
    const cached = JSON.parse(fileContent) as CachedCredentials;

    // Check if the cached credentials are still valid
    if (new Date(cached.Expiration) > new Date()) {
      console.log("Using cached AWS temporary credentials.");
      return cached;
    } else {
      console.log("Cached AWS temporary credentials expired. Will refresh.");
      // Optionally delete the expired file to clean up
      await fs.unlink(CACHE_FILE_PATH).catch(() => {}); // Delete, but don't error if it's already gone
      return null;
    }
  } catch (error) {
    // If file not found (ENOENT), it's not an error, just no cache.
    // Otherwise, log a warning for other read/parse errors.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      console.log("No cached AWS temporary credentials found.");
    } else {
      console.warn("Error reading or parsing cached credentials:", error);
    }
    return null;
  }
}

/**
 * Writes temporary credentials to a cache file.
 */
async function writeCachedCredentials(credentials: CachedCredentials): Promise<void> {
  try {
    const cacheDirPath = path.dirname(CACHE_FILE_PATH);
    console.log(`[Cache Write] Attempting to create directory: ${cacheDirPath}`);
    await fs.mkdir(cacheDirPath, { recursive: true });
    console.log(`[Cache Write] Directory created/exists: ${cacheDirPath}`);

    console.log(`[Cache Write] Attempting to write to file: ${CACHE_FILE_PATH}`);
    // Use mode 0o600 for owner read/write only, making the file less accessible
    await fs.writeFile(CACHE_FILE_PATH, JSON.stringify(credentials, null, 2), { encoding: 'utf8', mode: 0o600 });
    console.log(`[Cache Write] AWS temporary credentials successfully written to ${CACHE_FILE_PATH}`);
  } catch (error) {
    console.error("[Cache Write Error] Error writing cached credentials:", error);
  }
}

async function runCloudWatchQuery() {
  let credentials; // This will hold the credentials object for the SDK client

  try {
    // --- STEP 1: Handle MFA Credentials (with caching) ---
    const cachedCreds = await readCachedCredentials();

    if (cachedCreds) {
      // If valid cached credentials exist, use them
      credentials = {
        accessKeyId: cachedCreds.AccessKeyId,
        secretAccessKey: cachedCreds.SecretAccessKey,
        sessionToken: cachedCreds.SessionToken,
      };
    } else {
      // If no valid cache, obtain new credentials (will prompt for MFA)
      console.log("Obtaining new AWS temporary credentials with MFA...");
      const credentialsProvider = fromIni({
        profile: AWS_PROFILE,
        mfaCodeProvider: async (mfaSerial: string) => {
          return await promptForMfaCode(mfaSerial);
        },
      });
      const newCredentials = await credentialsProvider(); // This will trigger the MFA prompt

      // Ensure all necessary properties are present for caching
      if (newCredentials.accessKeyId && newCredentials.secretAccessKey &&
          newCredentials.sessionToken && newCredentials.expiration) {
        // Cache the newly obtained credentials
        await writeCachedCredentials({
          AccessKeyId: newCredentials.accessKeyId,
          SecretAccessKey: newCredentials.secretAccessKey,
          SessionToken: newCredentials.sessionToken,
          Expiration: newCredentials.expiration.toISOString(), // Convert Date to ISO string for storage
        });
        credentials = newCredentials; // Use the new credentials
      } else {
        throw new Error("Failed to obtain complete temporary credentials for caching.");
      }
    }

    // --- STEP 2: Initialize CloudWatchLogsClient with explicit region ---
    // The region is explicitly defined as a constant AWS_REGION
    console.log(`Using AWS Region: ${AWS_REGION}`);

    const client = new CloudWatchLogsClient({
      region: AWS_REGION, // Use the explicitly defined region
      credentials: credentials, // Pass the obtained credentials (cached or new)
    });

    // --- STEP 3: Run CloudWatch Logs Insights Query ---
    console.log(">>> Running initial CloudWatch Logs Insights query...");
    const startQueryCommand = new StartQueryCommand({
      logGroupName: LOG_GROUP_NAME,
      startTime: START_TIME_MS / 1000, // AWS SDK expects seconds for StartQueryCommand
      endTime: END_TIME_MS / 1000,
      queryString: QUERY_STRING,
    });

    const startQueryResponse = await client.send(startQueryCommand);
    const queryId = startQueryResponse.queryId;

    if (!queryId) {
      throw new Error("Failed to start CloudWatch Logs Insights query: No Query ID returned.");
    }

    console.log(`Started CloudWatch Logs Insights query: ${queryId}`);

    // --- STEP 4: Wait for Query Completion ---
    let status: QueryStatus | undefined = QueryStatus.Running;
    while (status === QueryStatus.Running || status === QueryStatus.Scheduled) {
      await new Promise((resolve) => setTimeout(resolve, 2000)); // Wait 2 seconds
      const getResultsCommand = new GetQueryResultsCommand({ queryId });
      const getResultsResponse = await client.send(getResultsCommand);
      status = getResultsResponse.status;
      console.log(`Query status: ${status}`);
    }

    // --- STEP 5: Get and Parse Results ---
    console.log("Extracting Results...");
    const getResultsCommand = new GetQueryResultsCommand({ queryId });
    const getResultsResponse = await client.send(getResultsCommand);

    const results = getResultsResponse.results;
    if (results && results.length > 0) {
      console.log(`\n--- Original Query Results (${results.length} rows) ---`);
      
      type Entry = { qProfile: string, service: string, hits: number };
      const entries: Entry[] = [];

      results.forEach((row) => {
        const rowData: Record<string, string> = {};
        row.forEach(pair => {
          rowData[pair.field] = pair.value;
        });

        entries.push({
          qProfile: rowData.qProfile,
          service: rowData.service,
          hits: parseInt(rowData.hits),
        });
      });

      // Print original rows
      entries.forEach(({ qProfile, service, hits }) => {
        console.log(`qProfile=${qProfile} | service=${service} | hits=${hits}`);
      });

      // Aggregate hits per qProfile
      const queuerStats: Record<string, number> = {};
      entries.forEach(({ qProfile, hits }) => {
        queuerStats[qProfile] = (queuerStats[qProfile] || 0) + hits;
      });

      console.log(`\n--- Queuer Load Summary (Most Loaded First) ---`);
      const sortedQueuers = Object.entries(queuerStats).sort((a, b) => b[1] - a[1]);
      sortedQueuers.forEach(([q, totalHits]) => {
        console.log(`${q}: ${totalHits} hits`);
      });

      const totalHitsAcrossAllQueuers = sortedQueuers.reduce((sum, [, hits]) => sum + hits, 0);
      const averageHitsPerQueuer = totalHitsAcrossAllQueuers / sortedQueuers.length;
      console.log(`\nAverage hits per queuer: ${Math.round(averageHitsPerQueuer)} hits`);

      // --- NEW BALANCING LOGIC ---
      console.log(`\n--- Suggested Reassignments to Balance Load (Revised) ---`);

      // Create a deep copy of currentLoad to simulate changes
      const simulatedQueuerLoad: Record<string, number> = JSON.parse(JSON.stringify(queuerStats));
      
      // Store potential reassignments
      const proposedChanges: { service: string, from: string, to: string, hits: number }[] = [];

      // Sort services by hits in descending order to prioritize larger moves
      const sortedServices = entries.sort((a, b) => b.hits - a.hits);

      // Define a tolerance for what's considered "balanced"
      const BALANCE_TOLERANCE_PERCENT = 0.05; // 5% tolerance
      const upperThreshold = averageHitsPerQueuer * (1 + BALANCE_TOLERANCE_PERCENT);
      const lowerThreshold = averageHitsPerQueuer * (1 - BALANCE_TOLERANCE_PERCENT);

      let changesMade = false;
      let iterationCount = 0;
      const MAX_ITERATIONS = 100; // Prevent infinite loops

      do {
        changesMade = false;
        iterationCount++;

        // Get current states of overloaded and underloaded queuers based on simulated load
        const currentOverloaded = Object.entries(simulatedQueuerLoad)
          .filter(([, hits]) => hits > upperThreshold)
          .sort((a, b) => b[1] - a[1]); // Sort overloaded by most overloaded first

        const currentUnderloaded = Object.entries(simulatedQueuerLoad)
          .filter(([, hits]) => hits < lowerThreshold)
          .sort((a, b) => a[1] - b[1]); // Sort underloaded by most underloaded first

        if (currentOverloaded.length === 0 || currentUnderloaded.length === 0) {
            // If no overloaded or no underloaded, or if they are within tolerance, we are done
            break; 
        }

        for (const [overloadedQ, overloadedHits] of currentOverloaded) {
          // Find services that can be moved from this overloaded queuer
          const servicesToMove = sortedServices.filter(s => s.qProfile === overloadedQ && s.hits > 0);

          for (const service of servicesToMove) {
            if (simulatedQueuerLoad[overloadedQ] <= upperThreshold) {
              // This queuer is no longer overloaded, move to the next overloaded queuer
              break; 
            }

            for (const [underloadedQ, underloadedHits] of currentUnderloaded) {
              // Avoid moving a service to the same queuer it's already on
              if (overloadedQ === underloadedQ) continue;

              // Check if moving this service to underloadedQ would keep it within the upper threshold
              // or at least reduce the overloadedQ's load significantly without greatly overshooting target
              if (simulatedQueuerLoad[underloadedQ] + service.hits <= upperThreshold) {
                // Proposed move
                proposedChanges.push({
                  service: service.service,
                  from: overloadedQ,
                  to: underloadedQ,
                  hits: service.hits,
                });

                // Apply the move to the simulated load
                simulatedQueuerLoad[overloadedQ] -= service.hits;
                simulatedQueuerLoad[underloadedQ] += service.hits;

                // Mark the service as "moved" for this iteration to avoid re-evaluating it
                service.hits = 0; 
                changesMade = true;
                break; // Found a place for this service, move to the next service
              }
            }
          }
        }
      } while (changesMade && iterationCount < MAX_ITERATIONS); // Continue if changes were made and max iterations not reached

      if (proposedChanges.length === 0) {
        console.log("No significant reassignments needed — system is balanced enough or no viable moves found.");
      } else {
        proposedChanges.forEach(({ service, from, to, hits }) => {
          console.log(`Move service ${service} (${hits} hits) from ${from} to ${to}`);
        });

        console.log(`\n--- Final Simulated Queuer Load After Reassignments ---`);
        const finalSortedQueuers = Object.entries(simulatedQueuerLoad).sort((a, b) => b[1] - a[1]);
        finalSortedQueuers.forEach(([q, totalHits]) => {
          console.log(`${q}: ${Math.round(totalHits)} hits`);
        });
      }

    } else {
      console.log("No results found for the query.");
    }

  } catch (error) {
    console.error("Error running CloudWatch Logs Insights query:", error);
  }
}

runCloudWatchQuery();
