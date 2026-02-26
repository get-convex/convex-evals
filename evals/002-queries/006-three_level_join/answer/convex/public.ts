import { v } from "convex/values";
import { query } from "./_generated/server";
import { Id } from "./_generated/dataModel";

export const getProAdminsByOrg = query({
  args: {
    organizationId: v.id("organizations"),
  },
  handler: async (ctx, args) => {
    // First get all teams in the organization
    const teams = await ctx.db
      .query("teams")
      .withIndex("by_org", (q) => q.eq("organizationId", args.organizationId))
      .collect();

    // Then get all members of those teams with the specified role
    const teamMembers = await Promise.all(
      teams.map(async (team) => {
        const members = await ctx.db
          .query("teamMembers")
          .withIndex("by_team_role", (q) =>
            q.eq("teamId", team._id).eq("role", "admin"),
          )
          .collect();
        return Promise.all(members.map((member) => ctx.db.get(member.userId)));
      }),
    );

    const result: Record<Id<"users">, string> = {};
    for (const user of teamMembers.flat()) {
      if (!user) {
        throw new Error("User not found");
      }
      result[user._id] = user.profileUrl;
    }
    return result;
  },
});
