import { IConfig, MailManager } from "./types";
import { ParsedMessage } from "@/types";
import { type gmail_v1, google } from "googleapis";
import * as he from "he";

function fromBinary(str: string) {
    return decodeURIComponent(
        atob(str.replace(/-/g, "+").replace(/_/g, "/"))
            .split("")
            .map(function (c) {
                return "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2);
            })
            .join(""),
    );
}

const findHtmlBody = (parts: any[]): string => {
    for (const part of parts) {
        if (part.mimeType === "text/html" && part.body?.data) {
            console.log("✓ Driver: Found HTML content in message part");
            return part.body.data;
        }
        if (part.parts) {
            const found = findHtmlBody(part.parts);
            if (found) return found;
        }
    }
    console.log("⚠️ Driver: No HTML content found in message parts");
    return "";
};

export const driver = async (config: IConfig): Promise<MailManager> => {
    const auth = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID as string,
        process.env.GOOGLE_CLIENT_SECRET as string,
        process.env.GOOGLE_REDIRECT_URI as string,
    );

    const getScope = () =>
        [
            "https://www.googleapis.com/auth/gmail.modify",
            "https://www.googleapis.com/auth/userinfo.profile",
            "https://www.googleapis.com/auth/userinfo.email",
        ].join(" ");
    if (config.auth) {
        auth.setCredentials({
            access_token: config.auth.access_token,
            refresh_token: config.auth.refresh_token,
            scope: getScope(),
        });
    }
    const parse = ({
        id,
        threadId,
        snippet,
        labelIds,
        payload,
    }: gmail_v1.Schema$Message): Omit<
        ParsedMessage,
        "body" | "processedHtml" | "blobUrl" | "totalReplies"
    > => {
        const receivedOn =
            payload?.headers?.find((h) => h.name?.toLowerCase() === "date")?.value || "Failed";
        const sender =
            payload?.headers?.find((h) => h.name?.toLowerCase() === "from")?.value || "Failed";
        const subject =
            payload?.headers?.find((h) => h.name?.toLowerCase() === "subject")?.value || "Failed";
        const references =
            payload?.headers?.find((h) => h.name?.toLowerCase() === "references")?.value || "";
        const inReplyTo =
            payload?.headers?.find((h) => h.name?.toLowerCase() === "in-reply-to")?.value || "";
        const messageId =
            payload?.headers?.find((h) => h.name?.toLowerCase() === "message-id")?.value || "";
        const [name, email] = sender.split("<");
        return {
            id: id || "ERROR",
            threadId: threadId || "",
            title: snippet ? he.decode(snippet).trim() : "ERROR",
            tags: labelIds || [],
            references,
            inReplyTo,
            sender: {
                name: name ? name.replace(/"/g, "").trim() : "Unknown",
                email: `<${email}`,
            }, 
            unread: labelIds ? labelIds.includes("UNREAD") : false,
            receivedOn,
            subject: subject ? subject.replace(/"/g, "").trim() : "No subject",
            messageId,
        }
    };
    const normalizeSearch = (folder: string, q: string) => {
        if (folder === "trash") {
            return { folder: undefined, q: `in:trash ${q}` };
        }
        return { folder, q };
    };
    const gmail = google.gmail({ version: "v1", auth });
    return {
        markAsRead: async (id: string[]) => {
            await gmail.users.messages.batchModify({
                userId: "me",
                requestBody: {
                    ids: id,
                    removeLabelIds: ["UNREAD"],
                },
            });
        },
        markAsUnread: async (id: string[]) => {
            await gmail.users.messages.batchModify({
                userId: "me",
                requestBody: {
                    ids: id,
                    addLabelIds: ["UNREAD"],
                },
            });
        },
        getScope,
        getUserInfo: (tokens: { access_token: string; refresh_token: string }) => {
            auth.setCredentials({ ...tokens, scope: getScope() });
            return google
                .people({ version: "v1", auth })
                .people.get({ resourceName: "people/me", personFields: "names,photos,emailAddresses" });
        },
        getTokens: async <T>(code: string) => {
            try {
                const { tokens } = await auth.getToken(code);
                return { tokens } as T;
            } catch (error) {
                console.error("Error getting tokens:", error);
                throw error;
            }
        },
        generateConnectionAuthUrl: (userId: string) => {
            return auth.generateAuthUrl({
                access_type: "offline",
                scope: getScope(),
                include_granted_scopes: true,
                prompt: "consent",
                state: userId,
            });
        },
        count: async () => {
            const userLabels = await gmail.users.labels.list({
                userId: 'me',
            });

            if (!userLabels.data.labels) {
                return { count: 0 };
            }
            return await Promise.all(
                userLabels.data.labels.map(async (label) => {
                    return gmail.users.labels.get({
                        userId: 'me',
                        id: label.id ?? undefined,
                    }).then((res) => ({
                        label: res.data.name,
                        count: res.data.threadsUnread
                    }))
                })
            )
        },
        list: async (folder, q, maxResults = 20, _labelIds: string[] = [], pageToken?: string) => {
            const { folder: normalizedFolder, q: normalizedQ } = normalizeSearch(folder, q ?? "");
            const labelIds = [..._labelIds];
            if (normalizedFolder) labelIds.push(normalizedFolder.toUpperCase());
            const res = await gmail.users.threads.list({
                userId: "me",
                q: normalizedQ ? normalizedQ : undefined,
                labelIds,
                maxResults,
                pageToken: pageToken ? pageToken : undefined,
            });
            const threads = await Promise.all(
                (res.data.threads || [])
                    .map(async (thread) => {
                        if (!thread.id) return null;
                        const msg = await gmail.users.threads.get({
                            userId: "me",
                            id: thread.id,
                            format: "metadata",
                            metadataHeaders: ["From", "Subject", "Date"],
                        });
                        const message = msg.data.messages?.[0];
                        const parsed = parse(message as any);
                        return {
                            ...parsed,
                            body: "",
                            processedHtml: "",
                            blobUrl: "",
                            totalReplies: msg.data.messages?.length || 0,
                            threadId: thread.id,
                        };
                    })
                    .filter((msg): msg is NonNullable<typeof msg> => msg !== null),
            );

            return { ...res.data, threads } as any;
        },
        get: async (id: string) => {
            const res = await gmail.users.threads.get({ userId: "me", id, format: "full" });
            const messages = res.data.messages?.map((message) => {
                const bodyData =
                    message.payload?.body?.data ||
                    (message.payload?.parts ? findHtmlBody(message.payload.parts) : "") ||
                    message.payload?.parts?.[0]?.body?.data ||
                    ""; // Fallback to first part

                if (!bodyData) {
                    console.log("⚠️ Driver: No email body data found");
                } else {
                    console.log("✓ Driver: Found email body data");
                }

                // Process the body content
                console.log("🔄 Driver: Processing email body...");
                const decodedBody = fromBinary(bodyData);

                console.log("✅ Driver: Email processing complete", {
                    hasBody: !!bodyData,
                    decodedBodyLength: decodedBody.length,
                });

                // Create the full email data
                const parsedData = parse(message);
                const fullEmailData = {
                    ...parsedData,
                    body: "",
                    processedHtml: "",
                    // blobUrl: `data:text/html;charset=utf-8,${encodeURIComponent(decodedBody)}`,
                    blobUrl: "",
                    decodedBody,
                };

                // Log the result for debugging
                console.log("📧 Driver: Returning email data", {
                    id: fullEmailData.id,
                    hasBody: !!fullEmailData.body,
                    hasBlobUrl: !!fullEmailData.blobUrl,
                    blobUrlLength: fullEmailData.blobUrl.length,
                });

                return fullEmailData;
            });
            return messages;
        },
        create: async (data: any) => {
            const res = await gmail.users.messages.send({ userId: "me", requestBody: data });
            return res.data;
        },
        delete: async (id: string) => {
            const res = await gmail.users.messages.delete({ userId: "me", id });
            return res.data;
        },
        normalizeIds: (ids) => {
            const normalizedIds: string[] = [];
            const threadIds: string[] = [];

            for (const id of ids) {
                if (id.startsWith('thread:')) {
                    threadIds.push(id.substring(7));
                } else {
                    normalizedIds.push(id);
                }
            }

            return { normalizedIds, threadIds };
        },
        async modifyLabels(id, options) {
            await gmail.users.messages.batchModify({
                userId: "me",
                requestBody: {
                    ids: id,
                    addLabelIds: options.addLabels,
                    removeLabelIds: options.removeLabels,
                },
            });
        },
    };
};