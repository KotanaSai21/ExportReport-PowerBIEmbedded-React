// ----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.
// ----------------------------------------------------------------------------

import { AuthenticationResult, InteractionType, EventMessage, EventType, AuthError } from "@azure/msal-browser";
import { MsalContext } from "@azure/msal-react";
import React from "react";
import { service, factories, models, IEmbedConfiguration } from "powerbi-client";
import "./App.css";
import * as config from "./Config";

const powerbi = new service.Service(factories.hpmFactory, factories.wpmpFactory, factories.routerFactory);

let accessToken = "";
let embedUrl = "";
let reportContainer: HTMLElement;
let reportRef: React.Ref<HTMLDivElement>;
let loading: JSX.Element;
let status: string;
let percentComplete;

// eslint-disable-next-line @typescript-eslint/no-empty-interface
interface AppProps { };
interface AppState { accessToken: string; embedUrl: string; error: string[] };

class App extends React.Component<AppProps, AppState> {
    static contextType = MsalContext;

    constructor(props: AppProps) {
        super(props);

        this.state = { accessToken: "", embedUrl: "", error: [] };

        reportRef = React.createRef();

        // Report container
        loading = (
            <div
                id="reportContainer"
                ref={reportRef} >
                Loading the report...
            </div>
        );
    }

    // React function
    render(): JSX.Element {

        if (this.state.error.length) {

            // Cleaning the report container contents and rendering the error message in multiple lines
            reportContainer.textContent = "";
            this.state.error.forEach(line => {
                reportContainer.appendChild(document.createTextNode(line));
                reportContainer.appendChild(document.createElement("br"));
            });
        }
        else if (this.state.accessToken !== "" && this.state.embedUrl !== "") {

            const embedConfiguration: IEmbedConfiguration = {
                type: "report",
                tokenType: models.TokenType.Aad,
                accessToken,
                embedUrl,
                id: config.reportId,
                /*
                // Enable this setting to remove gray shoulders from embedded report
                settings: {
                    background: models.BackgroundType.Transparent
                }
                */
            };

            const report = powerbi.embed(reportContainer, embedConfiguration);

            // Clear any other loaded handler events
            report.off("loaded");

            // Triggers when a content schema is successfully loaded
            report.on("loaded", function () {
                console.log("Report load successful");
            });

            // Clear any other rendered handler events
            report.off("rendered");

            // Triggers when a content is successfully embedded in UI
            report.on("rendered", function () {
                console.log("Report render successful");
            });

            // Clear any other error handler event
            report.off("error");

            // Below patch of code is for handling errors that occur during embedding
            report.on("error", function (event) {
                const errorMsg = event.detail;

                // Use errorMsg variable to log error in any destination of choice
                console.error(errorMsg);
            });
        }

        return loading;
    }

    // React function
    componentDidMount(): void {
        if (reportRef !== null) {
            reportContainer = reportRef["current"];
        }

        // User input - null check
        if (config.workspaceId === "" || config.reportId === "") {
            this.setState({ error: ["Please assign values to workspace Id and report Id in Config.ts file"] });
            return;
        }

        this.authenticate();
    }

    // React function
    componentDidUpdate(): void {
        this.authenticate();
    }

    // React function
    componentWillUnmount(): void {
        powerbi.reset(reportContainer);
    }

    // Authenticating to get the access token
    authenticate(): void {
        const msalInstance = this.context.instance;
        const msalAccounts = this.context.accounts;
        const msalInProgress = this.context.inProgress;
        const isAuthenticated = this.context.accounts.length > 0;

        if (this.state.error.length > 0) {
            return;
        }

        const eventCallback = msalInstance.addEventCallback((message: EventMessage) => {
            if (message.eventType === EventType.LOGIN_SUCCESS && !accessToken) {
                const payload = message.payload as AuthenticationResult;
                const name: string = payload.account?.name ? payload.account?.name: "";

                accessToken = payload.accessToken;
                this.setUsername(name);
                this.tryRefreshUserPermissions();
            }
        });

        const loginRequest = {
            scopes: config.scopeBase,
            account: msalAccounts[0]
        };

        if (!isAuthenticated && msalInProgress === InteractionType.None) {
            msalInstance.loginRedirect(loginRequest);
        }
        else if (isAuthenticated && accessToken && !embedUrl) {
            this.getembedUrl();
            msalInstance.removeEventCallback(eventCallback);
        }
        else if (isAuthenticated && !accessToken && !embedUrl && msalInProgress === InteractionType.None) {
            this.setUsername(msalAccounts[0].name);

            // get access token silently from cached id-token
            msalInstance.acquireTokenSilent(loginRequest).then((response: AuthenticationResult) => {
                accessToken = response.accessToken;
                this.getembedUrl();
            }).catch((error: AuthError) => {
                // Refresh access token silently from cached id-token
                // Makes the call to handleredirectcallback
                if (error.errorCode === "consent_required" || error.errorCode === "interaction_required" || error.errorCode === "login_required") {
                    msalInstance.acquireTokenRedirect(loginRequest);
                }
                else if (error.errorCode === '429') {
                    this.setState({ error: ["Our Service Token Server (STS) is overloaded, please try again in sometime"] });
                }
                else {
                    this.setState({ error: ["There was some problem fetching the access token" + error.toString()] });
                }
            });
        }
    }

    // Power BI REST API call to refresh User Permissions in Power BI
    // Refreshes user permissions and makes sure the user permissions are fully updated
    // https://docs.microsoft.com/rest/api/power-bi/users/refreshuserpermissions
    tryRefreshUserPermissions(): void {
        fetch(config.powerBiApiUrl + "v1.0/myorg/RefreshUserPermissions", {
            headers: {
                "Authorization": "Bearer " + accessToken
            },
            method: "POST"
        })
        .then(function (response) {
            if (response.ok) {
                console.log("User permissions refreshed successfully.");
            } else {
                // Too many requests in one hour will cause the API to fail
                if (response.status === 429) {
                    console.error("Permissions refresh will be available in up to an hour.");
                } else {
                    console.error(response);
                }
            }
        })
        .catch(function (error) {
            console.error("Failure in making API call." + error);
        });
    }

    // Power BI REST API call to get the embed URL of the report
    getembedUrl(): void {
        const thisObj: this = this;

        fetch(config.powerBiApiUrl + "v1.0/myorg/groups/" + config.workspaceId + "/reports/" + config.reportId, {
            headers: {
                "Authorization": "Bearer " + accessToken
            },
            method: "GET"
        })
            .then(function (response) {
                const errorMessage: string[] = [];
                errorMessage.push("Error occurred while fetching the embed URL of the report")
                errorMessage.push("Request Id: " + response.headers.get("requestId"));

                response.json()
                    .then(function (body) {
                        // Successful response
                        if (response.ok) {
                            embedUrl = body["embedUrl"];
                            thisObj.setState({ accessToken: accessToken, embedUrl: embedUrl });
                        }
                        // If error message is available
                        else {
                            errorMessage.push("Error " + response.status + ": " + body.error.code);

                            thisObj.setState({ error: errorMessage });
                        }

                    })
                    .catch(function () {
                        errorMessage.push("Error " + response.status + ":  An error has occurred");

                        thisObj.setState({ error: errorMessage });
                    });
            })
            .catch(function (error) {

                // Error in making the API call
                thisObj.setState({ error: error });
            })
    }

    // Show username in the UI
    setUsername(username: string): void {
        const welcome = document.getElementById("welcome");
        if (welcome !== null)
            welcome.innerText = "Welcome, " + username;
    }

    exportReport() {
        const settings = {
            format: 'PDF',
            powerBIReportConfiguration: {
                defaultBookmark: {
                        //    state: capturedBookmark.state
                                }            }
        };

        fetch(`https://api.powerbi.com/v1.0/myorg/reports/${config.reportId}/ExportTo` ,
            {
                method: 'POST',
                headers: {
                    "Authorization": "Bearer " + accessToken,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ format: "pdf"})
            })
            .then(response => response.json() )
            .then(data => {

            const exportId = data.id;
            const intervalId = setInterval(async () => {
                // Check the status of the export
                this.checkExportStatus(config.reportId,exportId);

                // Update the progress percentage
                // percentComplete = exportStatus.percentComplete === 0 ? 1 : exportStatus.percentComplete;                // console.log("Inside if",exportStatus.percentComplete)                
                if (status === 'Succeeded') {
                  // If the export succeeded, download the exported file and reset the interval                  console.log("if passed calling download")
                  this.downloadExportedFile(config.reportId,exportId);

                  clearInterval(intervalId);
                } else if (status !== 'Running') {
                  // If the export failed or is in an unknown state, reset the interval with an error message                  console.log("else failed")
                  clearInterval(intervalId);
                }
            }, 60);
            // Set a timeout to reset the interval in case the export takes too long
            setTimeout(() => {
                clearInterval(intervalId);
            }, 300000);

        }).catch(error => {
            console.error('Error:', error);
        });
    }

   checkExportStatus(reportId:any, exportId: string) {
        try {
            fetch(`https://api.powerbi.com/v1.0/myorg/reports/${reportId}/exports/${exportId}`,
            {
                headers: {
                    "Authorization": "Bearer " + accessToken,
                    'Content-Type': 'application/json'
                },
            }).then(response => response.json())
            .then( data => {
              // Do something with the JSON response data
              percentComplete= data.percentComplete;
              status = data.status;
            }).catch(error => {
              console.error(error);
            });
        } catch (error) {
            console.log(`Failed to check export status: ${error}`);
        }
    }

    downloadExportedFile(reportId: any, exportId: any) {
        // Download the exported file
        fetch(`https://api.powerbi.com/v1.0/myorg/reports/${reportId}/exports/${exportId}/file`,
        {
            headers: {
                "Authorization": "Bearer " + accessToken,
                'Content-Type': 'application/json'
            },
        }).then(response => response.blob())
        .then(blob => {
          // Do something with the blob data, e.g. create a URL for downloading the file
          const url = URL.createObjectURL(blob);
          const link = document.createElement('a');
          link.href = url;

            // Set the filename of the downloaded file
            link.download = reportId +'.pdf';

            // Append the link to the document body
            document.body.appendChild(link);

            // Trigger the download by clicking the link
            link.click();
            // Clean up by removing the link and revoking the URL
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
        }).catch(error => {
            console.error(error);
        });
    }
}

export default App;