FROM mcr.microsoft.com/dotnet/sdk:8.0-alpine AS build
WORKDIR /src
COPY NotificationService.csproj .
RUN dotnet restore
COPY *.cs ./
RUN dotnet publish -c Release --no-restore -o /out

FROM mcr.microsoft.com/dotnet/aspnet:8.0-alpine
WORKDIR /app
COPY --from=build /out .
USER app
EXPOSE 8085
ENTRYPOINT ["dotnet", "NotificationService.dll"]
